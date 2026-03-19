// utils/conversation-state.js
// Manejo de estado de conversaciones (en memoria)
// Para producción: usar Redis o base de datos

const conversationState = new Map();

// Obtener estado de una conversación
function getState(accountId, conversationId) {
  const key = `${accountId}_${conversationId}`;
  return conversationState.get(key) || {
    menu: 'principal',
    lastInteraction: Date.now(),
    meta: {}
  };
}

// Guardar estado de una conversación
function setState(accountId, conversationId, state) {
  const key = `${accountId}_${conversationId}`;
  conversationState.set(key, {
    ...state,
    lastInteraction: Date.now()
  });
}

// Limpiar estado de una conversación
function clearState(accountId, conversationId) {
  const key = `${accountId}_${conversationId}`;
  conversationState.delete(key);
}

// Limpiar estados antiguos (más de 24 horas)
function cleanupOldStates(maxAgeHours = 24) {
  const now = Date.now();
  const maxAge = maxAgeHours * 60 * 60 * 1000;
  
  for (const [key, state] of conversationState.entries()) {
    if (now - state.lastInteraction > maxAge) {
      conversationState.delete(key);
    }
  }
}

// Ejecutar limpieza cada hora
setInterval(cleanupOldStates, 60 * 60 * 1000);

module.exports = {
  getState,
  setState,
  clearState,
  cleanupOldStates
};