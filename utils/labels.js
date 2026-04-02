// utils/labels.js
const axios = require('axios');

/**
 * Establece UNA sola etiqueta principal, removiendo las demás
 * @param {string} accountId 
 * @param {string} conversationId 
 * @param {'bot'|'asesor'|'express'|'reclamos'} label - Etiqueta única a establecer
 */
async function setSingleLabel(accountId, conversationId, label) {
  try {
    const chatwootUrl = process.env.CHATWOOT_URL;
    const apiToken = process.env.CHATWOOT_TOKEN;
    
    if (!chatwootUrl || !apiToken) {
      console.error('❌ Faltan variables de entorno: CHATWOOT_URL o CHATWOOT_TOKEN');
      return { success: false, error: 'Missing env vars' };
    }

    const baseUrl = `${chatwootUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}`;
    const headers = {
      'api_access_token': apiToken,
      'Content-Type': 'application/json'
    };

    // ✅ Establecer SOLO la etiqueta especificada (reemplaza todas las demás)
    await axios.post(`${baseUrl}/labels`, { labels: [label] }, { headers, timeout: 5000 });
    console.log(`🏷️ Etiqueta establecida: [${label}]`);
    
    return { success: true, label };
    
  } catch (error) {
    console.error('❌ Error en setSingleLabel:', error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Obtiene la etiqueta principal actual de una conversación
 */
async function getCurrentLabel(accountId, conversationId) {
  try {
    const response = await axios.get(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}`,
      {
        headers: { 'api_access_token': process.env.CHATWOOT_TOKEN },
        timeout: 5000
      }
    );
    const labels = response.data.labels || [];
    const validLabels = ['bot', 'asesor', 'express', 'reclamos'];
    
    // Retornar la primera etiqueta válida encontrada
    return labels.find(l => validLabels.includes(l.toLowerCase())) || null;
    
  } catch (error) {
    console.error('⚠️ Error obteniendo etiqueta actual:', error.message);
    return null;
  }
}

module.exports = { setSingleLabel, getCurrentLabel };