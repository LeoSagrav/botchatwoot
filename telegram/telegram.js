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

// === CONFIGURACIÓN TELEGRAM (TU NÚMERO PERSONAL) ===
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

// === CREAR O ACTUALIZAR CONTACTO ===
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
        console.log(`✅ Contacto creado: ${telegramChatId}`);
        contactCache.set(cacheKey, response.data);
        return response.data;
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

// === 🔑 OBTENER SOURCE_ID ===
function getSourceIdForInbox(contact, inboxId) {
    if (contact?.contact_inboxes?.length > 0) {
        const inboxLink = contact.contact_inboxes.find(
            ci => ci.inbox?.id === inboxId || ci.inbox_id === inboxId
        );
        if (inboxLink?.source_id) return inboxLink.source_id;
    }
    if (contact?.identifier) return contact.identifier;
    if (contact?.custom_attributes?.telegram_chat_id) return contact.custom_attributes.telegram_chat_id;
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
            if (activeConv) return activeConv.id;
        }
    } catch (error) {
        if (error.response?.status !== 404) {
            console.error(`⚠️ Error buscando conversaciones:`, error.message);
        }
    }
    return null;
}

// === CREAR CONVERSACIÓN ===
async function createConversation(contact, telegramChatId) {
    try {
        const sourceId = getSourceIdForInbox(contact, CHATWOOT_INBOX_ID);
        if (!sourceId) return null;

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
        
        const response = await axios.post(
            `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
            requestData,
            { headers: getHeaders() }
        );
        console.log(`💬 Conversación creada: ${response.data.id}`);
        conversationCache.set(telegramChatId, response.data.id);
        return response.data.id;
    } catch (error) {
        if (error.response?.status === 400 || error.response?.data?.message?.includes('already')) {
            const existingConvId = await findActiveConversation(contact.id, telegramChatId);
            if (existingConvId) {
                conversationCache.set(telegramChatId, existingConvId);
                return existingConvId;
            }
        }
        console.error(`❌ Error conversación:`, error.response?.data || error.message);
        return null;
    }
}

// === 🔑 FUNCIÓN PRINCIPAL: OBTENER CONVERSACIÓN ===
async function getOrCreateConversation(telegramChatId, phoneNumber, senderName) {
    if (conversationCache.has(telegramChatId)) {
        const cachedId = conversationCache.get(telegramChatId);
        try {
            const check = await axios.get(
                `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${cachedId}`,
                { headers: getHeaders() }
            );
            if (check.data?.status !== "resolved") return cachedId;
        } catch (e) {
            conversationCache.delete(telegramChatId);
        }
    }

    const contact = await createOrUpdateContact(phoneNumber, senderName, telegramChatId);
    if (!contact?.id) return null;

    const isExistingContact = contact.created_at !== contact.updated_at || contactCache.has(`tg:${telegramChatId}`);
    if (isExistingContact) {
        const existingConvId = await findActiveConversation(contact.id, telegramChatId);
        if (existingConvId) {
            conversationCache.set(telegramChatId, existingConvId);
            return existingConvId;
        }
    }
    return await createConversation(contact, telegramChatId);
}

// === ENVIAR MENSAJE A CHATWOOT ===
async function sendToChatwoot(telegramChatId, messageText, senderName = "Usuario", messageType = "incoming", phoneNumber = null) {
    const conversationId = await getOrCreateConversation(telegramChatId, phoneNumber, senderName);
    if (!conversationId) return;

    try {
        await axios.post(
            `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
            { content: messageText, message_type: messageType, private: false },
            { headers: getHeaders() }
        );
        console.log(`📨 Mensaje sincronizado (Conv: ${conversationId})`);
    } catch (error) {
        if (error.response?.status === 404) {
            conversationCache.delete(telegramChatId);
            return sendToChatwoot(telegramChatId, messageText, senderName, messageType, phoneNumber);
        }
        console.error(`❌ Error Chatwoot:`, error.response?.data || error.message);
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

            // ✅ 1. Enviar TEXTO (igual que antes)
            if (messageContent) {
                await client.sendMessage(entity, { message: messageContent });
                console.log(`✅ Texto enviado`);
            }

            // ✅ 2. 🔥 ENVIAR IMÁGENES / ARCHIVOS (NUEVO)
            if (attachments.length > 0) {
                for (const att of attachments) {
                    try {
                        const fileUrl = att.data_url || att.file_url;

                        if (!fileUrl) continue;

                        console.log(`📷 Enviando archivo: ${fileUrl}`);

                        await client.sendFile(entity, {
                            file: fileUrl,
                            caption: messageContent || "",
                            forceDocument: false // 👈 se envía como imagen (no archivo)
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
    console.log("💡 Tus mensajes se sincronizarán como 'outgoing'");

    client.addEventHandler(async (event) => {
        const message = event.message;
        
        // ✅ FILTRO 1: Solo mensajes privados
        if (!message.isPrivate) {
            return;
        }

        const text = message.text || "";
        const chatId = message.chatId;
        const sender = message.sender;
        
        // ✅ FILTRO 2: Detectar si es mensaje TUYO o del cliente
        if (message.out) {
            // ✅ Es TU mensaje → Sincronizar como "outgoing"
            console.log(`📤 [Telegram] Tu mensaje a ${chatId}: ${text.substring(0, 50)}`);
            
            // Sincronizar como mensaje saliente (outgoing)
            await sendToChatwoot(chatId, text, me.firstName || "Agente", "outgoing", null);
            return;
        }

        // ✅ Es mensaje del CLIENTE → Sincronizar como "incoming"
        const senderName = sender?.firstName || "Usuario";
        const phoneNumber = sender?.phone ? `+${sender.phone}` : null;

        if (sender?.id) {
            telegramEntityCache.set(chatId, sender);
        }

        console.log(`📨 [Telegram] ${senderName} (${chatId}): ${text.substring(0, 50)}`);
        
        // Sincronizar como mensaje entrante (incoming)
        await sendToChatwoot(chatId, text, senderName, "incoming", phoneNumber);
    }, new NewMessage({}));

    const PORT = 3029;
    app.listen(PORT, () => {
        console.log(`\n🚀 Bridge en http://localhost:${PORT}`);
        console.log(`📡 Webhook: http://localhost:${PORT}/webhook/chatwoot-telegram`);
        console.log(`📦 Comprobantes: http://localhost:${PORT}/enviar-comprobante`);
        console.log(`✅ Listo - Mensajes bidireccionales sincronizados`);
    });
})();