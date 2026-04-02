// utils/conversation-state.js
const conversationState = new Map();
const handedOffConversations = new Set();
const handoffTimestamps = new Map(); // ⏱️ Nuevo: guarda hora de cada handoff

function getState(accountId, conversationId) {
  const key = `${accountId}_${conversationId}`;
  return conversationState.get(key) || {
    menu: 'principal',
    lastInteraction: Date.now(),
    meta: {}
  };
}

function setState(accountId, conversationId, state) {
  const key = `${accountId}_${conversationId}`;
  conversationState.set(key, { ...state, lastInteraction: Date.now() });
}

function clearState(accountId, conversationId) {
  const key = `${accountId}_${conversationId}`;
  conversationState.delete(key);
}

// ✅ Modificada: guarda timestamp al marcar handoff
function markAsHandoff(accountId, conversationId) {
  const key = `${accountId}_${conversationId}`;
  handedOffConversations.add(key);
  handoffTimestamps.set(key, Date.now()); // ⏱️ Guarda hora exacta
  console.log(`🔒 Conversación ${conversationId} marcada como handoff`);
}

function isHandedOff(accountId, conversationId) {
  const key = `${accountId}_${conversationId}`;
  return handedOffConversations.has(key);
}

// ✅ Modificada: limpia timestamp al liberar
function releaseHandoff(accountId, conversationId) {
  const key = `${accountId}_${conversationId}`;
  handedOffConversations.delete(key);
  handoffTimestamps.delete(key); // 🗑️ Limpia timestamp
  clearState(accountId, conversationId);
  console.log(`🔓 Conversación ${conversationId} liberada`);
}

function cleanupOldStates(maxAgeHours = 24) {
  const now = Date.now();
  const maxAge = maxAgeHours * 60 * 60 * 1000;
  for (const [key, state] of conversationState.entries()) {
    if (now - state.lastInteraction > maxAge) {
      conversationState.delete(key);
      handedOffConversations.delete(key);
      handoffTimestamps.delete(key); // 🧹 También limpia timestamps
    }
  }
}

// ✅ Nueva función: devuelve keys de handoffs expirados
function getExpiredHandoffs(timeoutMinutes) {
  const now = Date.now();
  const threshold = timeoutMinutes * 60 * 1000;
  const expired = [];
  
  for (const [key, timestamp] of handoffTimestamps.entries()) {
    if (now - timestamp > threshold) {
      expired.push(key);
    }
  }
  
  return expired;
}

// Limpieza automática cada hora
setInterval(cleanupOldStates, 60 * 60 * 1000);

module.exports = {
  getState,
  setState,
  clearState,
  markAsHandoff,
  isHandedOff,
  releaseHandoff,
  cleanupOldStates,
  getExpiredHandoffs // 👈 Nuevo export
};