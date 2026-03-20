// utils/conversation-state.js
const conversationState = new Map();
const handedOffConversations = new Set();

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

function markAsHandoff(accountId, conversationId) {
  const key = `${accountId}_${conversationId}`;
  handedOffConversations.add(key);
  console.log(`🔒 Conversación ${conversationId} marcada como handoff`);
}

function isHandedOff(accountId, conversationId) {
  const key = `${accountId}_${conversationId}`;
  return handedOffConversations.has(key);
}

function releaseHandoff(accountId, conversationId) {
  const key = `${accountId}_${conversationId}`;
  handedOffConversations.delete(key);
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
    }
  }
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
  cleanupOldStates
};