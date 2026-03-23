const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
app.use(express.json({ limit: '100mb' }));

// === CONFIGURACIÓN TELEGRAM ===
const apiId = 39897045;
const apiHash = "a5aff9fd7ed70051b207c325363f5bfd";
const stringSession = new StringSession("1AQAOMTQ5LjE1NC4xNzUuNTUBu5uadHHIWkJbaBHsVYx7x0jPZzhRNbpeDGrUSu67BhaSvPNJJYTX6IV/ZcfbjrSsu/m6teNtrb5Ce6hXH557mJVmPGzzeyg2sS/g+Ud346w9xUl0Dbgxtm/57d6vowqNxaj1gvbHFt86dnQ9ynDkyyBRrs1QEQXr9Tt5wIJwnbj7ObyCvsDG/x39x05d0m9KTqyFFsnUxrME6dAK0Y/ph/zAba8TrQuUuSi5DiO1gFO2W7HMBUQG01nFYgsaHpglZs1SDFvo7LOg8R8vaDEXDSdeM3TefxQHLcekbYCx7cjMDFgGCLC4LsDjKvJUeTsQ7qBYG2MMi3yuTKuNtioh1Rg=");

// === CONFIGURACIÓN CHATWOOT ===
const CHATWOOT_URL = "https://chat.importadoramiranda.com".trim();
const CHATWOOT_ACCOUNT_ID = 1;
const CHATWOOT_INBOX_ID = 11;
const CHATWOOT_API_TOKEN = "qgZitkvdxn6saxodq8SHoqDk";

// === CACHES ===
const contactCache = new Map();
const conversationCache = new Map();
const telegramEntityCache = new Map();

const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// === HEADERS ===
function getHeaders() {
    return {
        'api_access_token': CHATWOOT_API_TOKEN,
        'Content-Type': 'application/json'
    };
}

// === BUSCAR CONTACTO POR TELEGRAM ID ===
async function findContactByTelegramId(telegramChatId) {
    try {
        const searchResponse = await axios.get(
            `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/search`,
            { 
                headers: getHeaders(),
                params: { q: telegramChatId.toString(), page: 1 }
            }
        );
        if (searchResponse?.data?.payload?.length > 0) {
            const exactMatch = searchResponse.data.payload.find(
                c => c.identifier === telegramChatId.toString()
            );
            if (exactMatch) return exactMatch;
        }
    } catch (error) {
        console.error(`⚠️ Error buscando contacto:`, error.message);
    }
    return null;
}

// === CREAR O ACTUALIZAR CONTACTO (✅ CON REFRESH PARA contact_inboxes) ===
async function createOrUpdateContact(phoneNumber, firstName, telegramChatId) {
    const cacheKey = `tg:${telegramChatId}`;
    if (contactCache.has(cacheKey)) return contactCache.get(cacheKey);

    let contact = await findContactByTelegramId(telegramChatId);
    if (contact) {
        contactCache.set(cacheKey, contact);
        return contact;
    }

    try {
        const contactData = {
            inbox_id: CHATWOOT_INBOX_ID,
            name: firstName || `Usuario ${telegramChatId}`,
            identifier: telegramChatId.toString(),
            custom_attributes: {
                telegram_chat_id: telegramChatId.toString(),
                source: "telegram_userbot"
            }
        };
        if (phoneNumber && typeof phoneNumber === 'string' && phoneNumber.startsWith('+') && phoneNumber.length >= 8) {
            contactData.phone_number = phoneNumber;
        }

        const response = await axios.post(
            `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`,
            contactData,
            { headers: getHeaders() }
        );
        
        // ✅ CRÍTICO: Esperar y refrescar para obtener contact_inboxes con source_id
        await sleep(400);
        const refreshed = await axios.get(
            `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/${response.data.id}`,
            { headers: getHeaders() }
        );
        
        console.log(`✅ Contacto creado: ${telegramChatId}`);
        contactCache.set(cacheKey, refreshed.data);
        return refreshed.data;
        
    } catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        if (errorMsg.includes('Identifier has already been taken')) {
            await sleep(300);
            const retryContact = await findContactByTelegramId(telegramChatId);
            if (retryContact) {
                contactCache.set(cacheKey, retryContact);
                return retryContact;
            }
        }
        console.error(`❌ Error contacto:`, errorMsg);
        return null;
    }
}

// === 🔑 OBTENER SOURCE_ID (✅ CON RETRY Y LOGGING) ===
async function getSourceIdForInbox(contact, inboxId) {
    // 1️⃣ Intentar desde contact_inboxes
    if (contact?.contact_inboxes?.length > 0) {
        const inboxLink = contact.contact_inboxes.find(
            ci => ci.inbox?.id === inboxId || ci.inbox_id === inboxId
        );
        if (inboxLink?.source_id) {
            console.log(`🔑 source_id encontrado: ${inboxLink.source_id}`);
            return inboxLink.source_id;
        }
    }
    
    // 2️⃣ Refrescar contacto si contact_inboxes está vacío
    console.log(`🔄 contact_inboxes vacío, refrescando contacto ${contact?.id}...`);
    await sleep(500);
    try {
        const refreshed = await axios.get(
            `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/${contact?.id}`,
            { headers: getHeaders() }
        );
        
        if (refreshed.data?.contact_inboxes?.length > 0) {
            const inboxLink = refreshed.data.contact_inboxes.find(
                ci => ci.inbox?.id === inboxId || ci.inbox_id === inboxId
            );
            if (inboxLink?.source_id) {
                console.log(`🔑 source_id tras refresh: ${inboxLink.source_id}`);
                return inboxLink.source_id;
            }
        }
    } catch (e) {
        console.error(`⚠️ Error refrescando contacto:`, e.message);
    }
    
    // 3️⃣ Fallback: usar identifier (puede funcionar en algunos casos)
    if (contact?.identifier) {
        console.log(`⚠️ Fallback a identifier: ${contact.identifier}`);
        return contact.identifier;
    }
    
    console.error(`❌ No se pudo obtener source_id para inbox ${inboxId}`);
    return null;
}

// === 🔍 BUSCAR CONVERSACIÓN ACTIVA EXISTENTE ===
async function findActiveConversation(contactId, telegramChatId) {
    try {
        const response = await axios.get(
            `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/conversations`,
            { headers: getHeaders() }
        );
        if (response?.data?.payload?.length > 0) {
            const activeConv = response.data.payload.find(
                c => c.inbox_id === CHATWOOT_INBOX_ID && c.status !== "resolved"
            );
            if (activeConv) {
                console.log(`💬 Conversación existente encontrada: ${activeConv.id}`);
                return activeConv.id;
            }
        }
    } catch (error) {
        if (error.response?.status !== 404) {
            console.error(`⚠️ Error buscando conversaciones:`, error.message);
        }
    }
    return null;
}

// === CREAR CONVERSACIÓN (✅ CON LOGGING COMPLETO) ===
async function createConversation(contact, telegramChatId) {
    try {
        console.log(`🔄 Creando conversación para contacto ${contact?.id}...`);
        
        const sourceId = await getSourceIdForInbox(contact, CHATWOOT_INBOX_ID);
        if (!sourceId) {
            console.error(`❌ No se pudo obtener source_id, abortando creación`);
            return null;
        }

        const requestData = {
            source_id: sourceId,
            inbox_id: CHATWOOT_INBOX_ID,
            contact_id: contact.id,
            status: "open",
            custom_attributes: {
                telegram_chat_id: telegramChatId.toString(),
                source: "telegram_userbot"
            }
        };
        
        console.log(`📋 Request conversación:`, JSON.stringify({
            source_id: requestData.source_id.substring(0, 8) + '...',
            inbox_id: requestData.inbox_id,
            contact_id: requestData.contact_id
        }));
        
        const response = await axios.post(
            `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
            requestData,
            { headers: getHeaders() }
        );
        
        console.log(`💬 Conversación CREADA: ID=${response.data.id}`);
        console.log(`🔗 URL directa: ${CHATWOOT_URL}/app/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${response.data.id}`);
        
        conversationCache.set(telegramChatId, response.data.id);
        return response.data.id;
        
    } catch (error) {
        console.error(`❌ ERROR creando conversación:`);
        console.error(`   Status: ${error.response?.status}`);
        console.error(`   Data:`, error.response?.data);
        console.error(`   Message:`, error.message);
        
        // Si ya existe, buscarla
        if (error.response?.status === 400 || error.response?.data?.message?.includes('already')) {
            console.log(`🔄 Buscando conversación existente...`);
            const existingConvId = await findActiveConversation(contact.id, telegramChatId);
            if (existingConvId) {
                conversationCache.set(telegramChatId, existingConvId);
                return existingConvId;
            }
        }
        return null;
    }
}

// === 🔑 FUNCIÓN PRINCIPAL: OBTENER CONVERSACIÓN ===
async function getOrCreateConversation(telegramChatId, phoneNumber, senderName) {
    // 1️⃣ Cache en memoria
    if (conversationCache.has(telegramChatId)) {
        const cachedId = conversationCache.get(telegramChatId);
        try {
            const check = await axios.get(
                `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${cachedId}`,
                { headers: getHeaders() }
            );
            if (check.data?.status !== "resolved") {
                console.log(`⚡ Conversación desde cache: ${cachedId}`);
                return cachedId;
            }
        } catch (e) {
            console.log(`🔄 Conversación cacheada no encontrada`);
            conversationCache.delete(telegramChatId);
        }
    }

    // 2️⃣ Obtener o crear contacto
    const contact = await createOrUpdateContact(phoneNumber, senderName, telegramChatId);
    if (!contact?.id) {
        console.error(`❌ No se pudo obtener contacto para ${telegramChatId}`);
        return null;
    }

    // 3️⃣ Buscar conversación existente
    const existingConvId = await findActiveConversation(contact.id, telegramChatId);
    if (existingConvId) {
        conversationCache.set(telegramChatId, existingConvId);
        return existingConvId;
    }

    // 4️⃣ Crear nueva conversación
    return await createConversation(contact, telegramChatId);
}

// === ENVIAR MENSAJE A CHATWOOT ===
async function sendToChatwoot(telegramChatId, messageText, senderName = "Usuario", messageType = "incoming", phoneNumber = null) {
    console.log(`\n📨 sendToChatwoot: ${telegramChatId} | "${messageText?.substring(0, 30)}..."`);
    
    const conversationId = await getOrCreateConversation(telegramChatId, phoneNumber, senderName);
    
    if (!conversationId) {
        console.error(`❌ No se pudo obtener ID de conversación para ${telegramChatId}`);
        return;
    }

    try {
        console.log(`📤 Enviando mensaje a conversación ${conversationId}...`);
        
        const response = await axios.post(
            `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
            { content: messageText, message_type: messageType, private: false },
            { headers: getHeaders() }
        );
        
        console.log(`✅ Mensaje sincronizado (Conv: ${conversationId}, Msg ID: ${response.data?.id})`);
    } catch (error) {
        console.error(`❌ Error enviando mensaje:`);
        console.error(`   Status: ${error.response?.status}`);
        console.error(`   Data:`, error.response?.data);
        
        if (error.response?.status === 404) {
            console.log(`🔄 Conversación no encontrada, limpiando cache...`);
            conversationCache.delete(telegramChatId);
            return sendToChatwoot(telegramChatId, messageText, senderName, messageType, phoneNumber);
        }
    }
}

// === 🚨 WEBHOOK CHATWOOT ===
app.post("/webhook/chatwoot-telegram", async (req, res) => {
    const event = req.body;
    
    console.log("\n📡 === WEBHOOK ===");
    console.log(`📋 Evento: ${event.event}`);
    
    const messageType = event.message_type;
    const isOutgoing = messageType === 1 || messageType === 'outgoing';
    const messageContent = event.content;
    const telegramChatId = event.conversation?.custom_attributes?.telegram_chat_id;
    const attachments = event.attachments || [];
    
    console.log(`🔍 messageType: ${messageType} → isOutgoing: ${isOutgoing}`);
    console.log(`🔍 content: "${messageContent?.substring(0, 50)}"`);
    console.log(`🔍 telegram_chat_id: ${telegramChatId}`);
    console.log(`🔍 attachments: ${attachments.length}`);
    
    if (event.event === "message_created" && isOutgoing && telegramChatId) {
        console.log(`\n📤 ENVIANDO A TELEGRAM:`);
        console.log(`   🆔 Chat ID: ${telegramChatId}`);

        try {
            let entity = telegramEntityCache.get(telegramChatId);
            if (!entity) {
                console.log(`🔍 Resolviendo entidad...`);
                entity = await client.getEntity(telegramChatId);
                telegramEntityCache.set(telegramChatId, entity);
            }

            // ✅ 1. Enviar TEXTO
            if (messageContent) {
                await client.sendMessage(entity, { message: messageContent });
                console.log(`✅ Texto enviado`);
            }

            // ✅ 2. Enviar IMÁGENES / ARCHIVOS
            if (attachments.length > 0) {
                for (const att of attachments) {
                    try {
                        const fileUrl = att.data_url || att.file_url;
                        if (!fileUrl) continue;

                        console.log(`📷 Enviando archivo: ${fileUrl}`);
                        await client.sendFile(entity, {
                            file: fileUrl,
                            caption: messageContent || "",
                            forceDocument: false
                        });
                        console.log(`✅ Imagen enviada`);
                    } catch (fileErr) {
                        console.error(`❌ Error enviando archivo: ${fileErr.message}`);
                    }
                }
            }

            console.log(`✅ ✅ ✅ MENSAJE COMPLETO ENVIADO ✅ ✅ ✅`);
            
        } catch (err) {
            console.error(`❌ ERROR: ${err.message}`);
            try {
                const entity = await client.getEntity(telegramChatId);
                telegramEntityCache.set(telegramChatId, entity);

                if (messageContent) {
                    await client.sendMessage(entity, { message: messageContent });
                }
                if (attachments.length > 0) {
                    for (const att of attachments) {
                        const fileUrl = att.data_url || att.file_url;
                        if (fileUrl) {
                            await client.sendFile(entity, {
                                file: fileUrl,
                                caption: messageContent || "",
                                forceDocument: false
                            });
                        }
                    }
                }
                console.log(`✅ Reintento exitoso`);
            } catch (err2) {
                console.error(`❌ Reintento fallido: ${err2.message}`);
            }
        }
    }
    
    console.log("📡 === FIN ===\n");
    res.status(200).send("OK");
});

// === ENVIAR COMPROBANTE ===
app.post("/enviar-comprobante", async (req, res) => {
    let { telefono, pdfBase64, pedidoId, mensaje } = req.body;
    let tempFilePath = null;

    try {
        console.log(`\n📦 Pedido #${pedidoId} para ${telefono}`);
        if (!telefono.startsWith('+')) telefono = `+${telefono}`;
        if (!pdfBase64) throw new Error("No hay PDF");

        const buffer = Buffer.from(pdfBase64, 'base64');
        if (!buffer.slice(0, 5).equals(Buffer.from('%PDF-'))) {
            throw new Error("PDF inválido");
        }

        tempFilePath = path.join(os.tmpdir(), `miranda_${pedidoId}.pdf`);
        fs.writeFileSync(tempFilePath, buffer);

        let entity = telegramEntityCache.get(telefono);
        if (!entity) {
            for (let i = 0; i < 3; i++) {
                try {
                    entity = await client.getEntity(telefono);
                    telegramEntityCache.set(telefono, entity);
                    break;
                } catch (e) {
                    if (i === 2) throw e;
                    await sleep(1000 * (i + 1));
                }
            }
        }

        await client.sendFile(entity, {
            file: tempFilePath,
            fileName: `Comprobante_${pedidoId}.pdf`,
            caption: mensaje,
            parseMode: "markdown",
            forceDocument: true
        });

        const chatId = entity.id || telefono;
        await sendToChatwoot(chatId, `📄 Comprobante #${pedidoId} enviado`, "Sistema", "outgoing");
        console.log(`✅ PDF enviado`);
        res.json({ success: true });
    } catch (error) {
        console.error(`❌ Error:`, error.message);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    }
});

// === INICIALIZACIÓN ===
(async () => {
    await client.start();
    
    const me = await client.getMe();
    const BOT_OWNER_ID = me.id;
    
    console.log("\n✅ === TELEGRAM INICIADO ===");
    console.log("🔐 Usuario:", me.firstName);
    console.log("📱 Número: +", me.phone);
    console.log(`🆔 TU ID: ${BOT_OWNER_ID}`);
    console.log("💡 Conversaciones con source_id correcto para interfaz");

    client.addEventHandler(async (event) => {
        const message = event.message;
        if (!message.isPrivate) return;

        const text = message.text || "";
        const chatId = message.chatId;
        const sender = message.sender;
        
        if (message.out) {
            console.log(`📤 [Telegram] Tu mensaje a ${chatId}: ${text.substring(0, 50)}`);
            await sendToChatwoot(chatId, text, me.firstName || "Agente", "outgoing", null);
            return;
        }

        const senderName = sender?.firstName || "Usuario";
        const phoneNumber = sender?.phone ? `+${sender.phone}` : null;

        if (sender?.id) {
            telegramEntityCache.set(chatId, sender);
        }

        console.log(`📨 [Telegram] ${senderName} (${chatId}): ${text.substring(0, 50)}`);
        await sendToChatwoot(chatId, text, senderName, "incoming", phoneNumber);
    }, new NewMessage({}));

    const PORT = 3029;
    app.listen(PORT, () => {
        console.log(`\n🚀 Bridge en http://localhost:${PORT}`);
        console.log(`📡 Webhook: http://localhost:${PORT}/webhook/chatwoot-telegram`);
        console.log(`📦 Comprobantes: http://localhost:${PORT}/enviar-comprobante`);
        console.log(`✅ Listo - Conversaciones visibles en interfaz`);
    });
})();