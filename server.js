require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const { getState, setState, clearState, markAsHandoff, isHandedOff, releaseHandoff } = require('./utils/conversation-state');

const app = express();
const PORT = process.env.PORT || 3000;

// Cargar configuración del bot
const botConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'bot-config.json'), 'utf8')
);

// Middleware
app.use(bodyParser.json());

// Función para limpiar HTML
function cleanText(text) {
  if (!text) return '';
  return text.replace(/<[^>]*>/g, '').trim().toLowerCase();
}

// Endpoint de salud
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    bot: process.env.BOT_NAME,
    timestamp: new Date().toISOString()
  });
});

// Webhook principal de Chatwoot
app.post('/webhook/chatwoot', async (req, res) => {
  try {
    // === EXTRAER CAMPOS (estructura real de Chatwoot) ===
    const accountId = req.body.account?.id;
    const conversationId = req.body.conversation?.id;
    const message_type = req.body.message_type;
    const content = req.body.content;
    const inbox_id = req.body.inbox?.id;
    
    // 🔑 CORRECCIÓN: sender_type está en conversation.meta.sender.type
    const sender_type = req.body.conversation?.meta?.sender?.type;
    const contactId = req.body.conversation?.meta?.sender?.id;
    
    // Limpiar contenido
    const cleanContent = cleanText(content);
    
    console.log('\n🔔 Webhook:');
    console.log('  account:', accountId);
    console.log('  conversation:', conversationId);
    console.log('  message_type:', message_type);
    console.log('  sender_type:', sender_type);
    console.log('  content:', cleanContent);
    console.log('  inbox:', inbox_id);

    // Validar que sea mensaje entrante de contacto
    if (message_type !== 'incoming' || sender_type !== 'contact') {
      console.log('⏭️ Ignorando (no es incoming/contact)');
      return res.sendStatus(200);
    }

    if (!cleanContent) {
      console.log('⏭️ Ignorando (vacío)');
      return res.sendStatus(200);
    }

    // 🔥 VERIFICAR SI YA FUE TRANSFERIDA A HUMANO
    if (isHandedOff(accountId, conversationId)) {
      console.log(`⏭️ Conversación ${conversationId} ya está con asesor humano - Bot ignorando`);
      return res.sendStatus(200);  // ✅ No responde, solo confirma recepción
    }

    console.log(`💬 Procesando: "${cleanContent}"`);

    // Estado de conversación
    let state = getState(accountId, conversationId);
    const message = cleanContent;

    // === PALABRAS CLAVE ===
    
    // Handoff - Transferir a asesor humano
    if (botConfig.keywords.handoff.some(k => message.includes(k))) {
      console.log('✅ Handoff solicitado');
      await sendHandoff(accountId, conversationId, contactId);
      return res.sendStatus(200);
    }

    // Volver al menú principal
    if (botConfig.keywords.back.some(k => message.includes(k))) {
      console.log('✅ Volviendo al menú principal');
      state.menu = 'principal';
      setState(accountId, conversationId, state);
      await sendMessage(accountId, conversationId, botConfig.menus.principal.greeting);
      return res.sendStatus(200);
    }

    // Saludo - Permite reiniciar incluso después de handoff
    if (botConfig.keywords.greeting.some(k => message.includes(k))) {
      console.log('✅ Saludo detectado');
      
      // Si estaba en handoff, liberar para que el bot vuelva a responder
      if (isHandedOff(accountId, conversationId)) {
        releaseHandoff(accountId, conversationId);
        console.log('🔄 Handoff liberado por saludo del cliente');
      }
      
      state.menu = 'principal';
      setState(accountId, conversationId, state);
      await sendMessage(accountId, conversationId, botConfig.menus.principal.greeting);
      return res.sendStatus(200);
    }

    // === PROCESAR MENÚ ===
    const currentMenu = botConfig.menus[state.menu];
    
    if (currentMenu?.options?.[message]) {
      console.log(`✅ Opción "${message}" del menú "${state.menu}"`);
      const option = currentMenu.options[message];
      
      await sendMessage(accountId, conversationId, option.message);
      
      if (option.handoff) {
        await sendHandoff(accountId, conversationId, contactId);
      } else if (option.backTo) {
        state.menu = option.backTo;
        setState(accountId, conversationId, state);
        if (botConfig.menus[state.menu]?.greeting) {
          await sendMessage(accountId, conversationId, botConfig.menus[state.menu].greeting);
        }
      } else if (option.submenu) {
        state.menu = option.submenu;
        setState(accountId, conversationId, state);
      } else if (option.end) {
        if (option.showMenuAgain) {
          await sendMessage(accountId, conversationId, '\n\n¿Necesitas algo más? Escribe *menú* para ver opciones.');
        }
        clearState(accountId, conversationId);
      }
    } else {
      console.log('❌ Mensaje no reconocido');
      await sendMessage(accountId, conversationId, botConfig.messages.unrecognized);
      state.menu = 'principal';
      setState(accountId, conversationId, state);
    }

    res.sendStatus(200);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Stack:', error.stack);
    res.sendStatus(500);
  }
});

// Enviar mensaje a Chatwoot
async function sendMessage(accountId, conversationId, content) {
  console.log(`📤 Enviando mensaje a conv ${conversationId}`);
  
  try {
    const response = await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
      {
        content: content,
        message_type: 'outgoing',
        private: false
      },
      {
        headers: {
          'api_access_token': process.env.CHATWOOT_TOKEN,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    console.log('✅ Mensaje enviado (status:', response.status + ')');
    return response;
  } catch (error) {
    console.error('❌ Error enviando mensaje:');
    console.error('  Status:', error.response?.status);
    console.error('  Data:', error.response?.data);
    throw error;
  }
}

// Handoff a asesor humano
async function sendHandoff(accountId, conversationId, contactId) {
  console.log('👤 Realizando handoff a asesor humano...');
  
  try {
    // 🔥 MARCAR conversación como handoff (para que el bot ignore futuros mensajes)
    markAsHandoff(accountId, conversationId);
    
    // Enviar mensaje de confirmación al cliente
    await sendMessage(accountId, conversationId, botConfig.messages.handoffConfirmation);
    
    // Agregar nota privada para el equipo
    await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
      {
        content: `🤖 *Bot:* Cliente ${contactId} solicitó atención humana. *El bot ha dejado de responder automáticamente.*`,
        message_type: 'note',
        private: true
      },
      {
        headers: {
          'api_access_token': process.env.CHATWOOT_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    
    // Marcar conversación como prioritaria y con atributos personalizados
    await axios.patch(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}`,
      { 
        status: 'open', 
        priority: 'high',
        custom_attributes: { 
          handled_by_bot: false, 
          requires_human: true,
          handoff_at: new Date().toISOString()
        }
      },
      {
        headers: {
          'api_access_token': process.env.CHATWOOT_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('✅ Handoff completado - Bot dejará de responder');
  } catch (error) {
    console.error('❌ Error en handoff:', error.message);
  }
}

// Iniciar servidor
app.listen(PORT, () => {
  console.log('\n🤖 Bot de Chatwoot corriendo en puerto ' + PORT);
  console.log('📡 Webhook URL: /webhook/chatwoot');
  console.log('🔗 Chatwoot: ' + process.env.CHATWOOT_URL);
  console.log('✅ Health check: http://localhost:' + PORT + '/health');
  console.log('\n⚙️ Configuración:');
  console.log('  Account ID:', process.env.CHATWOOT_ACCOUNT_ID);
  console.log('  Token:', process.env.CHATWOOT_TOKEN ? 'Configurado (' + process.env.CHATWOOT_TOKEN.substring(0, 10) + '...)' : 'NO CONFIGURADO');
  console.log('  Bot Name:', process.env.BOT_NAME);
  console.log('\n🎯 Listo para recibir mensajes...\n');
});