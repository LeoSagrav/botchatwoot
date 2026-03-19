require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const { getState, setState, clearState } = require('./utils/conversation-state');

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

    console.log(`💬 Procesando: "${cleanContent}"`);

    // Estado de conversación
    let state = getState(accountId, conversationId);
    const message = cleanContent;

    // === PALABRAS CLAVE ===
    
    // Handoff
    if (botConfig.keywords.handoff.some(k => message.includes(k))) {
      console.log('✅ Handoff');
      await sendHandoff(accountId, conversationId, contactId);
      clearState(accountId, conversationId);
      return res.sendStatus(200);
    }

    // Volver al menú
    if (botConfig.keywords.back.some(k => message.includes(k))) {
      console.log('✅ Menú principal');
      state.menu = 'principal';
      setState(accountId, conversationId, state);
      await sendMessage(accountId, conversationId, botConfig.menus.principal.greeting);
      return res.sendStatus(200);
    }

    // Saludo
    if (botConfig.keywords.greeting.some(k => message.includes(k))) {
      console.log('✅ Saludo');
      state.menu = 'principal';
      setState(accountId, conversationId, state);
      await sendMessage(accountId, conversationId, botConfig.menus.principal.greeting);
      return res.sendStatus(200);
    }

    // === MENÚ ===
    const currentMenu = botConfig.menus[state.menu];
    
    if (currentMenu?.options?.[message]) {
      console.log(`✅ Opción "${message}"`);
      const option = currentMenu.options[message];
      
      await sendMessage(accountId, conversationId, option.message);
      
      if (option.handoff) {
        await sendHandoff(accountId, conversationId, contactId);
        clearState(accountId, conversationId);
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
      console.log('❌ No reconocido');
      await sendMessage(accountId, conversationId, botConfig.messages.unrecognized);
      state.menu = 'principal';
      setState(accountId, conversationId, state);
    }

    res.sendStatus(200);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.sendStatus(500);
  }
});

// Enviar mensaje
async function sendMessage(accountId, conversationId, content) {
  console.log(`📤 Enviando a conv ${conversationId}`);
  
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
    console.log('✅ Enviado (status:', response.status + ')');
    return response;
  } catch (error) {
    console.error('❌ Error enviando:');
    console.error('  Status:', error.response?.status);
    console.error('  Data:', error.response?.data);
    throw error;
  }
}

// Handoff
async function sendHandoff(accountId, conversationId, contactId) {
  console.log('👤 Handoff...');
  
  try {
    await sendMessage(accountId, conversationId, botConfig.messages.handoffConfirmation);
    
    await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
      {
        content: `🤖 Bot: Cliente ${contactId} solicitó asesor.`,
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
    
    await axios.patch(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}`,
      { status: 'open', priority: 'high' },
      {
        headers: {
          'api_access_token': process.env.CHATWOOT_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('✅ Handoff OK');
  } catch (error) {
    console.error('❌ Error handoff:', error.message);
  }
}

// Iniciar
app.listen(PORT, () => {
  console.log('\n🤖 Bot en puerto ' + PORT);
  console.log('📡 Webhook: /webhook/chatwoot');
  console.log('🔗 Chatwoot: ' + process.env.CHATWOOT_URL);
  console.log('✅ Health: http://localhost:' + PORT + '/health\n');
});