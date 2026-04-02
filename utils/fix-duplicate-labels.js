// utils/fix-duplicate-labels.js
// Corrige conversaciones con múltiples etiquetas válidas
require('dotenv').config();
const axios = require('axios');

const CHATWOOT_URL = process.env.CHATWOOT_URL;
const CHATWOOT_ACCOUNT_ID = parseInt(process.env.CHATWOOT_ACCOUNT_ID);
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const DRY_RUN = process.argv.includes('--dry');

// Prioridad: si hay múltiples, mantener la de mayor prioridad
const PRIORITY_ORDER = ['reclamos', 'express', 'asesor', 'bot'];

function getHeaders() {
  return { 'api_access_token': CHATWOOT_TOKEN, 'Content-Type': 'application/json' };
}

async function main() {
  console.log('🔧 === CORREGIR ETIQUETAS DUPLICADAS ===\n');
  
  let page = 1, fixed = 0, total = 0;
  
  while (true) {
    try {
      const response = await axios.get(
        `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
        { headers: getHeaders(), params: { page, per_page: 100 }, timeout: 10000 }
      );
      
      const convs = response.data.payload || response.data.data?.payload || [];
      if (convs.length === 0) break;
      
      for (const conv of convs) {
        total++;
        const labels = conv.labels || [];
        const validLabels = labels.filter(l => ['bot', 'asesor', 'express', 'reclamos'].includes(l.toLowerCase()));
        
        // Si tiene MÁS de una etiqueta válida, corregir
        if (validLabels.length > 1) {
          // Mantener la de mayor prioridad
          const labelToKeep = PRIORITY_ORDER.find(p => validLabels.includes(p)) || validLabels[0];
          
          if (DRY_RUN) {
            console.log(`🔍 [DRY] Conv #${conv.id}: [${validLabels.join(', ')}] → [${labelToKeep}]`);
          } else {
            await axios.post(
              `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conv.id}/labels`,
              { labels: [labelToKeep] },
              { headers: getHeaders(), timeout: 5000 }
            );
            console.log(`✅ Conv #${conv.id}: [${validLabels.join(', ')}] → [${labelToKeep}]`);
          }
          fixed++;
          await new Promise(r => setTimeout(r, 50));
        }
      }
      
      console.log(`📄 Página ${page}: ${convs.length} procesadas (total: ${total}, corregidas: ${fixed})`);
      page++;
      
    } catch (error) {
      console.error(`❌ Error en página ${page}:`, error.message);
      break;
    }
  }
  
  console.log(`\n📊 Total conversaciones: ${total}`);
  console.log(`✅ Corregidas: ${fixed} ${DRY_RUN ? '(dry run)' : ''}`);
}

main().catch(error => {
  console.error('💥 Error:', error.message);
  process.exit(1);
});