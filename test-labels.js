// test-labels.js
require('dotenv').config();
const { syncLabels } = require('./utils/labels');

// === CONFIGURACIÓN DE PRUEBA ===
const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CONVERSATION_ID = process.argv[2] || process.env.TEST_CONVERSATION_ID;

if (!CONVERSATION_ID) {
  console.log('📝 Uso: node test-labels.js <conversation_id>');
  console.log('   O agrega TEST_CONVERSATION_ID=123 a tu .env');
  process.exit(1);
}

(async () => {
  console.log(`🧪 Probando syncLabels en conversación #${CONVERSATION_ID}\n`);
  
  // Ejemplo 1: Agregar etiqueta 'bot'
  console.log('➡️ Prueba 1: Agregar etiqueta "bot"');
  await syncLabels(ACCOUNT_ID, CONVERSATION_ID, { add: ['bot'] });
  
  // Ejemplo 2: Agregar 'asesor' y remover 'bot'
  console.log('\n➡️ Prueba 2: Cambiar de "bot" a "asesor"');
  await syncLabels(ACCOUNT_ID, CONVERSATION_ID, { add: ['asesor'], remove: ['bot'] });
  
  // Ejemplo 3: Agregar múltiples sin remover
  console.log('\n➡️ Prueba 3: Agregar "express" sin remover otras');
  await syncLabels(ACCOUNT_ID, CONVERSATION_ID, { add: ['express'] });
  
  console.log('\n✅ Pruebas completadas. Revisa Chatwoot para confirmar.');
  process.exit(0);
})();