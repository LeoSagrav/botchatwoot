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
async function sendQRPaymentFlow(accountId, conversationId) {
  console.log(`🖼️ Enviando QR + mensaje de pago a conv ${conversationId}`);
  
  try {
    const qrConfig = botConfig.media?.qrPayment;
    
    if (!qrConfig?.url) {
      console.error('❌ URL del QR no configurada');
      return;
    }

    const cleanUrl = qrConfig.url.trim();
    console.log(`🔗 URL del QR: ${cleanUrl}`);

    try {
      await axios.post(
        `${process.env.CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
        {
          content: qrConfig.caption || '📱 Código QR para pago',
          message_type: 'outgoing',
          private: false,
          attachments: [{ remote_file_url: cleanUrl }]
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
      try {
        const imageResponse = await axios.get(cleanUrl, { responseType: 'arraybuffer', timeout: 10000 });
        const imageBuffer = Buffer.from(imageResponse.data);
        const contentType = imageResponse.headers['content-type'] || 'image/jpeg';
        const FormData = require('form-data');
        const form = new FormData();
        form.append('content', qrConfig.caption || '📱 Código QR para pago');
        form.append('message_type', 'outgoing');
        form.append('private', 'false');
        form.append('attachments[]', imageBuffer, { filename: 'qr-miranda.jpg', contentType });
        
        await axios.post(
          `${process.env.CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
          form,
          { headers: { 'api_access_token': process.env.CHATWOOT_TOKEN, ...form.getHeaders() }, timeout: 15000 }
        );
        console.log('✅ Imagen QR enviada como archivo binario');
      } catch (binaryError) {
        console.error('❌ Error en método binario:', binaryError.message);
        throw binaryError;
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, 800));
    
    await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
      { content: botConfig.messages.qrPayment, message_type: 'outgoing', private: false },
      { headers: { 'api_access_token': process.env.CHATWOOT_TOKEN, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    console.log('✅ Mensaje de pago enviado');
    
  } catch (error) {
    console.error('❌ Error enviando QR payment:');
    console.error('  Status:', error.response?.status);
    console.error('  Data:', error.response?.data);
    console.log('⚠️ Fallback: Enviando solo texto con link al QR...');
    try {
      const fallbackMessage = `📱 Escanea este QR para pagar tu pedido\n\n🔗 ${botConfig.media?.qrPayment?.url?.trim()}\n\n${botConfig.messages.qrPayment}`;
      await sendMessage(accountId, conversationId, fallbackMessage);
      console.log('✅ Fallback enviado correctamente');
    } catch (fallbackError) {
      console.error('❌ Error en fallback:', fallbackError.message);
    }
  }
}

// 🔥 NUEVA FUNCIÓN: Flujo de reclamos - CORREGIDA
async function sendReclamosFlow(accountId, conversationId, contactId) {
  console.log(`📋 Enviando flujo de reclamos a conv ${conversationId}`);
  
  try {
    // 1. Enviar mensaje de instrucciones (en un solo mensaje)
    await sendMessage(accountId, conversationId, botConfig.messages.reclamosInstructions);
    
    // 2. Agregar etiqueta "reclamos" a la conversación en Chatwoot
    try {
      // ✅ CORRECTO: Usar el endpoint correcto para labels
      await axios.post(
        `${process.env.CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/labels`,
        { 
          labels: ['reclamos']
        },
        {
          headers: {
            'api_access_token': process.env.CHATWOOT_TOKEN,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      console.log('✅ Etiqueta "reclamos" agregada a la conversación');
    } catch (labelError) {
      console.error('⚠️ No se pudo agregar la etiqueta "reclamos":', labelError.response?.data || labelError.message);
      // Continuar aunque falle la etiqueta
    }
    
    
    
    // 3. Marcar como prioritaria y con atributos personalizados - CORREGIDO
    try {
      await axios.patch(
        `${process.env.CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}`,
        { 
          status: 'open',
          priority: 'high',
          custom_attributes: { 
            handled_by_bot: false,
            requires_human: true,
            complaint_type: 'reclamos',
            reclamo_at: new Date().toISOString()
          }
        },
        {
          headers: {
            'api_access_token': process.env.CHATWOOT_TOKEN,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      console.log('✅ Conversación actualizada con prioridad alta y atributos');
    } catch (updateError) {
      console.error('⚠️ Error actualizando conversación:', updateError.response?.data || updateError.message);
      // Continuar aunque falle la actualización
    }
    
    // 4. MARCAR COMO HANDOFF - ESTO ES LO MÁS IMPORTANTE
    markAsHandoff(accountId, conversationId);
    console.log('✅ Handoff marcado - Bot dejará de responder');
    
    // 6. Asignar al equipo correcto (opcional - si tienes un team_id)
    try {
      if (process.env.CHATWOOT_TEAM_ID) {
        await axios.post(
          `${process.env.CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/assignments`,
          {
            team_id: parseInt(process.env.CHATWOOT_TEAM_ID)
          },
          {
            headers: {
              'api_access_token': process.env.CHATWOOT_TOKEN,
              'Content-Type': 'application/json'
            },
            timeout: 10000
          }
        );
        console.log('✅ Conversación asignada al equipo de reclamos');
      }
    } catch (assignError) {
      console.log('⚠️ No se pudo asignar al equipo (opcional)');
    }
    
    console.log('✅ Flujo de reclamos COMPLETADO - Bot detenido para esta conversación');
    
  } catch (error) {
    console.error('❌ Error en flujo de reclamos:', error.message);
    // Asegurar que se marque el handoff incluso si hay error
    markAsHandoff(accountId, conversationId);
    console.log('⚠️ Handoff forzado por error');
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
    
    // 🔥 RECLAMOS - Por keyword directa (bypass handoff también)
    if (botConfig.keywords.reclamos?.some(k => message === k)) {
      console.log('✅ Reclamo solicitado por keyword exacta');
      await sendReclamosFlow(accountId, conversationId, contactId);
      return res.sendStatus(200);
    }

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

    // 🔥 Opción 7 del menú - Reclamos
    if (message === '7' || message === 'reclamos_trigger') {
      console.log('✅ Opción 7/Reclamos detectada desde menú');
      await sendReclamosFlow(accountId, conversationId, contactId);
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
      
      // Si es acción especial
      if (option.action === 'send_qr_payment') {
        await sendQRPaymentFlow(accountId, conversationId);
      } else if (option.action === 'send_reclamos_flow') {
        await sendReclamosFlow(accountId, conversationId, contactId);
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