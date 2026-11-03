export const RESTART_STATE_FILE = '/c/workspace/symbiote/.restart_state';

export function saveRestartState(state: { restartAttempts: number } | null) {
  const fs = require('fs');
  if (state) {
    fs.writeFileSync(RESTART_STATE_FILE, JSON.stringify(state));
  } else {
    try { fs.unlinkSync(RESTART_STATE_FILE); } catch {}
  }
}

export function loadRestartState(): { restartAttempts: number } | null {
  try {
    const fs = require('fs');
    const data = fs.readFileSync(RESTART_STATE_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}