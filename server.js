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

// 🔥 Función para enviar imagen + texto de pago QR
// 🔥 Función para enviar imagen + texto de pago QR
async function sendQRPaymentFlow(accountId, conversationId) {
  console.log(`🖼️ Enviando QR + mensaje de pago a conv ${conversationId}`);
  
  try {
    const qrConfig = botConfig.media?.qrPayment;
    
    if (!qrConfig?.url) {
      console.error('❌ URL del QR no configurada');
      return;
    }

    // 🔥 Limpiar URL (quitar espacios en blanco)
    const cleanUrl = qrConfig.url.trim();
    console.log(`🔗 URL del QR: ${cleanUrl}`);

    // Paso 1: Enviar la imagen del QR
    // ✅ Formato CORRECTO para Chatwoot: remote_file_url para URLs remotas
    try {
      await axios.post(
        `${process.env.CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
        {
          content: qrConfig.caption || '📱 Código QR para pago',
          message_type: 'outgoing',
          private: false,
          attachments: [
            {
              remote_file_url: cleanUrl  // ✅ Usar remote_file_url en lugar de file_url
            }
          ]
        },
        {
          headers: {
            'api_access_token': process.env.CHATWOOT_TOKEN,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );
      console.log('✅ Imagen QR enviada correctamente');
      
    } catch (imageError) {
      console.error('⚠️ Error enviando imagen, intentando método alternativo...');
      
      // 🔥 MÉTODO ALTERNATIVO: Descargar imagen y enviar como archivo
      try {
        const imageResponse = await axios.get(cleanUrl, {
          responseType: 'arraybuffer',
          timeout: 10000
        });
        
        const imageBuffer = Buffer.from(imageResponse.data);
        const contentType = imageResponse.headers['content-type'] || 'image/jpeg';
        
        // Crear FormData para upload
        const FormData = require('form-data');
        const form = new FormData();
        form.append('content', qrConfig.caption || '📱 Código QR para pago');
        form.append('message_type', 'outgoing');
        form.append('private', 'false');
        form.append('attachments[]', imageBuffer, {
          filename: 'qr-miranda.jpg',
          contentType: contentType
        });
        
        await axios.post(
          `${process.env.CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
          form,
          {
            headers: {
              'api_access_token': process.env.CHATWOOT_TOKEN,
              ...form.getHeaders()
            },
            timeout: 15000
          }
        );
        console.log('✅ Imagen QR enviada como archivo binario');
        
      } catch (binaryError) {
        console.error('❌ Error en método binario:', binaryError.message);
        throw binaryError;
      }
    }
    
    // Pequeña pausa para asegurar orden de mensajes
    await new Promise(resolve => setTimeout(resolve, 800));
    
    // Paso 2: Enviar el mensaje de texto con instrucciones
    await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
      {
        content: botConfig.messages.qrPayment,
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
    console.log('✅ Mensaje de pago enviado');
    
  } catch (error) {
    console.error('❌ Error enviando QR payment:');
    console.error('  Status:', error.response?.status);
    console.error('  Data:', error.response?.data);
    
    // 🔥 Fallback final: Enviar solo texto con link
    console.log('⚠️ Fallback: Enviando solo texto con link al QR...');
    try {
      const fallbackMessage = `📱 Escanea este QR para pagar tu pedido

🔗 ${botConfig.media?.qrPayment?.url?.trim()}

🛍️ ¡TU PEDIDO CASI ESTÁ EN CAMINO!

🚛 Agenda: Los pedidos se enviarán a partir del 3 a 5 dias habiles (Recojo en La Paz por la tarde).

Paga vía QR el monto de tu compra. 📲

Importante: Ten listas las fotos de tus productos y tu comprobante de pago. 🧾

Sube tus datos y capturas al siguiente formulario

🌐 https://shop.importadoramiranda.com/live

¡Tu pedido así de fácil y rápido! 🎊`;
      
      await sendMessage(accountId, conversationId, fallbackMessage);
      console.log('✅ Fallback enviado correctamente');
    } catch (fallbackError) {
      console.error('❌ Error en fallback:', fallbackError.message);
    }
  }
}
// Función para enviar mensaje de texto normal
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
  console.log('👤 Realizando handoff...');
  
  try {
    markAsHandoff(accountId, conversationId);
    
    await sendMessage(accountId, conversationId, botConfig.messages.handoffConfirmation);
    
    await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
      {
        content: `🤖 *Bot:* Cliente ${contactId} solicitó atención humana. *El bot ha dejado de responder.*`,
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
    
    console.log('✅ Handoff completado');
  } catch (error) {
    console.error('❌ Error en handoff:', error.message);
  }
}

// Webhook principal de Chatwoot
app.post('/webhook/chatwoot', async (req, res) => {
  try {
    // === EXTRAER CAMPOS ===
    const accountId = req.body.account?.id;
    const conversationId = req.body.conversation?.id;
    const message_type = req.body.message_type;
    const content = req.body.content;
    const inbox_id = req.body.inbox?.id;
    
    const sender_type = req.body.conversation?.meta?.sender?.type;
    const contactId = req.body.conversation?.meta?.sender?.id;
    
    const cleanContent = cleanText(content);
    
    console.log('\n🔔 Webhook:');
    console.log('  conversation:', conversationId);
    console.log('  content:', cleanContent);

    // Validar que sea mensaje entrante de contacto
    if (message_type !== 'incoming' || sender_type !== 'contact') {
      return res.sendStatus(200);
    }

    if (!cleanContent) {
      return res.sendStatus(200);
    }

    // 🔥 PRIORIDAD MÁXIMA: "miranda" EXACTO siempre ejecuta QR (incluso si hay handoff)
    if (cleanContent === 'miranda') {
      console.log('✅ "miranda" exacto detectado - Ejecutando QR payment (bypass handoff)');
      await sendQRPaymentFlow(accountId, conversationId);
      
      // Mostrar menú nuevamente
      await new Promise(resolve => setTimeout(resolve, 800));
      await sendMessage(accountId, conversationId, '\n\n¿Necesitas algo más? Escribe *menú* para ver opciones.');
      return res.sendStatus(200);
    }

    // 🔥 Verificar si ya fue transferida a humano (para todos los demás mensajes)
    if (isHandedOff(accountId, conversationId)) {
      console.log(`⏭️ Conversación ${conversationId} ya está con asesor humano - Bot ignorando`);
      return res.sendStatus(200);
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

    // 🔥 Opción 4 del menú - Enviar QR de pago
    if (botConfig.keywords.miranda?.includes(message) || message === 'miranda_trigger') {
      console.log('✅ Opción 4/Miranda detectada desde menú');
      await sendQRPaymentFlow(accountId, conversationId);
      
      const currentMenu = botConfig.menus[state.menu];
      const option = currentMenu?.options?.[message] || currentMenu?.options?.['4'];
      
      if (option?.showMenuAgain) {
        await new Promise(resolve => setTimeout(resolve, 800));
        await sendMessage(accountId, conversationId, '\n\n¿Necesitas algo más? Escribe *menú* para ver opciones.');
      }
      clearState(accountId, conversationId);
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
      
      // Si es acción especial (como send_qr_payment)
      if (option.action === 'send_qr_payment') {
        await sendQRPaymentFlow(accountId, conversationId);
      } else {
        await sendMessage(accountId, conversationId, option.message);
      }
      
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

// Iniciar servidor
app.listen(PORT, () => {
  console.log('\n🤖 Bot corriendo en puerto ' + PORT);
  console.log('📡 Webhook: /webhook/chatwoot');
  console.log('🔗 Chatwoot: ' + process.env.CHATWOOT_URL);
  console.log('✅ Health: http://localhost:' + PORT + '/health\n');
  console.log('⚙️ Configuración:');
  console.log('  Account ID:', process.env.CHATWOOT_ACCOUNT_ID);
  console.log('  QR Payment URL:', botConfig.media?.qrPayment?.url || 'No configurado');
  console.log('\n🎯 Listo para recibir mensajes...\n');
});