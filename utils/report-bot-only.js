// utils/report-bot-only.js
// ✅ Genera Excel con conversaciones donde TODOS los mensajes salientes coinciden con bot-config.json
// ❌ Excluye conversaciones con mensajes personalizados (intervención humana)
// 🔒 Solo lectura: NO modifica nada en Chatwoot
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

// === CONFIGURACIÓN ===
const CHATWOOT_URL = process.env.CHATWOOT_URL;
const CHATWOOT_ACCOUNT_ID = parseInt(process.env.CHATWOOT_ACCOUNT_ID);
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const INBOX_ID = parseInt(process.env.CHATWOOT_INBOX_ID) || 8;
const BOT_CONFIG_PATH = path.join(__dirname, '..', 'bot-config.json');

const OUTPUT_FILE = process.argv.find(a => a.startsWith('--output='))?.split('=')[1] || 'reports/bot-only.xlsx';
const DELAY_MS = parseInt(process.argv.find(a => a.startsWith('--delay='))?.split('=')[1]) || 100;

// === HEADERS ===
function getHeaders() {
  return { 'api_access_token': CHATWOOT_TOKEN, 'Content-Type': 'application/json' };
}

// === EXTRAER CONVERSACIONES ===
function extractConversations(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.payload)) return data.payload;
  if (data.data && Array.isArray(data.data.payload)) return data.data.payload;
  if (Array.isArray(data.data)) return data.data;
  return [];
}

// === ✅ CARGAR RESPUESTAS PREDEFINIDAS DEL BOT ===
function loadBotResponses() {
  try {
    const config = JSON.parse(fs.readFileSync(BOT_CONFIG_PATH, 'utf8'));
    const responses = new Set();
    
    // Función para limpiar texto (igual que en el bot)
    const clean = (text) => {
      if (!text) return '';
      return text.replace(/<[^>]*>/g, '').trim().toLowerCase();
    };
    
    // 1. Mensajes del menú principal
    if (config.menus?.principal?.options) {
      for (const opt of Object.values(config.menus.principal.options)) {
        if (opt.message && !opt.message.includes('_trigger')) {
          responses.add(clean(opt.message));
        }
      }
    }
    
    // 2. Mensajes del submenú pedidos
    if (config.menus?.pedidos?.options) {
      for (const opt of Object.values(config.menus.pedidos.options)) {
        if (opt.message && !opt.message.includes('_trigger')) {
          responses.add(clean(opt.message));
        }
      }
    }
    
    // 3. Mensajes predefinidos
    if (config.messages) {
      for (const msg of Object.values(config.messages)) {
        if (msg && typeof msg === 'string') {
          responses.add(clean(msg));
        }
      }
    }
    
    // 4. Greeting del menú principal
    if (config.menus?.principal?.greeting) {
      responses.add(clean(config.menus.principal.greeting));
    }
    
    console.log(`📚 Respuestas del bot cargadas: ${responses.size} patrones`);
    return responses;
    
  } catch (error) {
    console.error('❌ Error cargando bot-config.json:', error.message);
    return new Set();
  }
}

// === ✅ VERIFICAR SI UN MENSAJE COINCIDE CON RESPUESTAS DEL BOT ===
function isBotResponse(messageContent, botResponses) {
  if (!messageContent || !botResponses.size) return false;
  
  const clean = (text) => {
    if (!text) return '';
    return text.replace(/<[^>]*>/g, '').trim().toLowerCase();
  };
  
  const cleaned = clean(messageContent);
  
  // Coincidencia exacta
  if (botResponses.has(cleaned)) return true;
  
  // Coincidencia parcial (para mensajes largos o con variaciones mínimas)
  for (const response of botResponses) {
    // Si el mensaje contiene la respuesta predefinida o viceversa
    if (cleaned.includes(response) || response.includes(cleaned)) {
      // Verificar que sea al menos 80% similar para evitar falsos positivos
      const similarity = calculateSimilarity(cleaned, response);
      if (similarity >= 0.8) return true;
    }
  }
  
  return false;
}

// === Calcular similitud entre dos textos (0 a 1) ===
function calculateSimilarity(a, b) {
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1.0;
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

// === Distancia de Levenshtein para similitud ===
function levenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i-1) === a.charAt(j-1)) {
        matrix[i][j] = matrix[i-1][j-1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i-1][j-1] + 1,
          matrix[i][j-1] + 1,
          matrix[i-1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

// === ✅ VERIFICAR SI UNA CONVERSACIÓN FUE ATENDIDA SOLO POR EL BOT ===
async function isBotOnlyConversation(accountId, conversationId, botResponses) {
  try {
    const response = await axios.get(
      `${CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
      { headers: getHeaders(), params: { per_page: 200 }, timeout: 10000 }
    );
    
    const messages = response.data.payload || response.data.data?.payload || [];
    
    // Filtrar solo mensajes salientes (del bot o agente)
    const outgoingMessages = messages.filter(msg => msg.message_type === 'outgoing');
    
    // Si no hay mensajes salientes, no es una conversación válida para este reporte
    if (outgoingMessages.length === 0) return false;
    
    // Verificar CADA mensaje saliente
    for (const msg of outgoingMessages) {
      const content = msg.content || '';
      
      // Si el mensaje NO coincide con las respuestas predefinidas del bot → hubo humano
      if (!isBotResponse(content, botResponses)) {
        return false; // ❌ Intervención humana detectada
      }
    }
    
    return true; // ✅ Todos los mensajes coinciden con el bot
    
  } catch (error) {
    console.error(`⚠️ Error en conv #${conversationId}:`, error.message);
    return false; // Por seguridad, excluir si hay error
  }
}

// === GUARDAR REPORTE EN EXCEL ===
function ensureOutputDir() {
  const dir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function saveToExcel(results, inboxName) {
  ensureOutputDir();
  
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Solo-Bot');
  
  // Título
  worksheet.mergeCells('A1:F1');
  const titleRow = worksheet.getRow(1);
  titleRow.getCell(1).value = `🤖 Conversaciones 100% Bot — ${inboxName}`;
  titleRow.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  titleRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E5984' } };
  titleRow.alignment = { vertical: 'middle', horizontal: 'center' };
  titleRow.height = 30;
  
  // Columnas
  worksheet.columns = [
    { header: 'ID', key: 'conversationId', width: 12 },
    { header: 'Nombre', key: 'contactName', width: 30 },
    { header: 'Teléfono', key: 'contactPhone', width: 20 },
    { header: 'Creada', key: 'createdAt', width: 22 },
    { header: 'Mensajes', key: 'messageCount', width: 12 },
    { header: 'Etiquetas', key: 'labels', width: 25 }
  ];
  
  // Encabezado
  const headerRow = worksheet.getRow(2);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 25;
  
  // Datos
  results.forEach(r => {
    worksheet.addRow({
      conversationId: r.conversationId,
      contactName: r.contactName || '',
      contactPhone: r.contactPhone || '',
      createdAt: r.createdAt ? new Date(r.createdAt).toLocaleString('es-BO') : '',
      messageCount: r.messageCount,
      labels: (r.labels || []).join(', ')
    });
  });
  
  // Formato: filas en verde suave
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber > 2) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2F0D9' } };
    }
  });
  
  // Filtros y congelar encabezado
  worksheet.views = [{ state: 'frozen', ySplit: 2 }];
  worksheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: 6 } };
  
  await workbook.xlsx.writeFile(OUTPUT_FILE);
  console.log(`📄 Excel guardado: ${path.resolve(OUTPUT_FILE)}`);
}

// === FUNCIÓN PRINCIPAL ===
async function main() {
  console.log('\n🔍 === REPORTE: Conversaciones 100% atendidas por el bot ===');
  console.log(`🌐 Chatwoot: ${CHATWOOT_URL}`);
  console.log(`📊 Cuenta: ${CHATWOOT_ACCOUNT_ID}`);
  console.log(`📬 Inbox ID: ${INBOX_ID}`);
  console.log(`📝 Output: ${OUTPUT_FILE}`);
  console.log(`⏱️ Delay: ${DELAY_MS}ms`);
  console.log(`🔒 Modo: SOLO LECTURA\n`);

  if (!CHATWOOT_URL || !CHATWOOT_TOKEN) {
    console.error('❌ Faltan variables de entorno');
    process.exit(1);
  }

  // Cargar respuestas del bot
  console.log(`📚 Cargando respuestas de: ${BOT_CONFIG_PATH}`);
  const botResponses = loadBotResponses();
  if (botResponses.size === 0) {
    console.error('❌ No se pudieron cargar las respuestas del bot');
    process.exit(1);
  }
  console.log();

  // Obtener nombre del inbox
  let inboxName = `Inbox #${INBOX_ID}`;
  try {
    const inboxRes = await axios.get(
      `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/inboxes/${INBOX_ID}`,
      { headers: getHeaders(), timeout: 5000 }
    );
    inboxName = inboxRes.data.name || inboxName;
  } catch {}

  let page = 1, total = 0, botOnly = 0, inboxFiltered = 0;
  const results = [];
  const startTime = Date.now();

  console.log(`🚀 Analizando inbox "${inboxName}"...\n`);

  while (true) {
    try {
      const response = await axios.get(
        `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
        { 
          headers: getHeaders(), 
          params: { page, per_page: 100, inbox_id: INBOX_ID }, 
          timeout: 15000 
        }
      );

      const convs = extractConversations(response.data);
      if (convs.length === 0) break;

      inboxFiltered += convs.length;

      for (const conv of convs) {
        total++;
        
        // Solo procesar conversaciones con etiqueta 'bot'
        const labels = conv.labels || [];
        if (!labels.includes('bot')) continue;
        
        // 🔍 Verificar si TODOS los mensajes coinciden con el bot
        const isBotOnly = await isBotOnlyConversation(CHATWOOT_ACCOUNT_ID, conv.id, botResponses);
        
        // ✅ Si es 100% bot → agregar al reporte
        if (isBotOnly) {
          botOnly++;
          
          // Contar mensajes salientes
          try {
            const msgRes = await axios.get(
              `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conv.id}/messages`,
              { headers: getHeaders(), params: { per_page: 1 }, timeout: 5000 }
            );
            const msgCount = (msgRes.data.payload || msgRes.data.data?.payload || []).filter(m => m.message_type === 'outgoing').length;
            
            results.push({
              conversationId: conv.id,
              contactName: conv.meta?.sender?.name || '',
              contactPhone: conv.meta?.sender?.phone_number || '',
              createdAt: conv.created_at,
              messageCount: msgCount,
              labels
            });
          } catch {
            results.push({
              conversationId: conv.id,
              contactName: conv.meta?.sender?.name || '',
              contactPhone: conv.meta?.sender?.phone_number || '',
              createdAt: conv.created_at,
              messageCount: 0,
              labels
            });
          }
        }
        
        if (total % 20 === 0) {
          console.log(`📊 Progreso: ${total} revisadas, ${botOnly} 100% bot`);
        }
        
        await new Promise(r => setTimeout(r, DELAY_MS));
      }

      console.log(`📄 Página ${page}: ${convs.length} conversaciones (total: ${total})`);
      page++;
      
    } catch (error) {
      console.error(`❌ Error en página ${page}:`, error.message);
      break;
    }
  }

  // Guardar Excel
  await saveToExcel(results, inboxName);
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log(`\n📊 === RESUMEN ===`);
  console.log(`📬 Conversaciones del inbox: ${inboxFiltered}`);
  console.log(`📋 Con etiqueta 'bot': ${total}`);
  console.log(`🤖 Atendidas 100% por bot: ${botOnly}`);
  console.log(`⏱️ Tiempo: ${duration} segundos`);
  console.log(`📄 Excel: ${path.resolve(OUTPUT_FILE)}`);
  console.log(`\n✅ Proceso completado.`);
}

main().catch(error => {
  console.error('💥 Error:', error.message);
  process.exit(1);
});