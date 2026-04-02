// utils/labels.js
const axios = require('axios');

// 🔑 Función principal: agrega/remueve etiquetas SIN borrar las existentes
async function syncLabels(accountId, conversationId, { add = [], remove = [] } = {}) {
  try {
    const chatwootUrl = process.env.CHATWOOT_URL;
    const apiToken = process.env.CHATWOOT_TOKEN;
    
    if (!chatwootUrl || !apiToken) {
      console.error('❌ Faltan variables de entorno: CHATWOOT_URL o CHATWOOT_TOKEN');
      return false;
    }

    const baseUrl = `${chatwootUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}`;
    const headers = {
      'api_access_token': apiToken,
      'Content-Type': 'application/json'
    };

    // 1️⃣ GET: obtener etiquetas actuales
    const getResponse = await axios.get(`${baseUrl}`, { headers, timeout: 5000 });
    const currentLabels = getResponse.data.labels || [];
    console.log(`📥 Etiquetas actuales: [${currentLabels.join(', ')}]`);

    // 2️⃣ Procesar: remover primero, luego agregar
    let finalLabels = [...currentLabels];
    
    // Remover etiquetas especificadas
    if (remove.length > 0) {
      finalLabels = finalLabels.filter(label => !remove.includes(label));
      console.log(`🗑️ Removidas: [${remove.join(', ')}]`);
    }
    
    // Agregar etiquetas nuevas (sin duplicados)
    if (add.length > 0) {
      for (const label of add) {
        if (!finalLabels.includes(label)) {
          finalLabels.push(label);
        }
      }
      console.log(`➕ Agregadas: [${add.join(', ')}]`);
    }

    // 3️⃣ POST: actualizar solo si cambió algo
    const labelsChanged = JSON.stringify(currentLabels.sort()) !== JSON.stringify(finalLabels.sort());
    if (labelsChanged) {
      await axios.post(`${baseUrl}/labels`, { labels: finalLabels }, { headers, timeout: 5000 });
      console.log(`✅ Etiquetas actualizadas: [${finalLabels.join(', ')}]`);
    } else {
      console.log(`ℹ️ Sin cambios en etiquetas`);
    }
    
    return { success: true, before: currentLabels, after: finalLabels };
    
  } catch (error) {
    console.error('❌ Error en syncLabels:', error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

// 🔹 Función simple para compatibilidad con código anterior
async function syncLabelsSimple(accountId, conversationId, labels = []) {
  return syncLabels(accountId, conversationId, { add: labels, remove: [] });
}

module.exports = { syncLabels, syncLabelsSimple };