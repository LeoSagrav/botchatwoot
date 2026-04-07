const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'bot-power-state.json');

// Estado inicial por defecto
const initialState = {
  enabled: true,
  lastUpdated: new Date().toISOString()
};

function getBotPowerState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      saveBotPowerState(initialState);
      return initialState;
    }
    const data = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('❌ Error leyendo bot-power-state.json:', error.message);
    return initialState;
  }
}

function saveBotPowerState(state) {
  try {
    const data = {
      ...state,
      lastUpdated: new Date().toISOString()
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('❌ Error guardando bot-power-state.json:', error.message);
  }
}

module.exports = {
  getBotPowerState,
  saveBotPowerState
};
