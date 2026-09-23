// The settings and help panels, and the rule that they close when you look away.

import { post, readPref, state, writePref } from './core.js';

const settingsPanel = document.getElementById('settingsPanel');
const concurrencyInput = document.getElementById('concurrency');
const bufferInput = document.getElementById('bufferMB');
const muteInput = document.getElementById('muteFrontends');

/**
 * Fills the settings panel from the server's current settings.
 * @param settings - the settings as the server reports them
 */
export function renderSettings(settings) {
  if (!settings) return;
  state.settings = settings;
  concurrencyInput.value = String(settings.resolvedConcurrency);
  document.getElementById('concurrencyValue').textContent = String(settings.resolvedConcurrency);
  document.getElementById('concurrencyHint').textContent =
    `Each start runs a webpack build. This machine suggests ${settings.recommended}` +
    `${settings.startConcurrency === null ? ' (in use, auto-detected)' : ''}.`;
  bufferInput.value = String(settings.bufferMB);
  document.getElementById('bufferValue').textContent = String(settings.bufferMB);
  muteInput.checked = settings.muteFrontends === true;
}

/**
 * Sends changed settings to the server, which owns and persists them.
 * @param changes - the fields to change
 */
async function pushSettings(changes) {
  renderSettings(await post('/api/settings', changes));
}

document.getElementById('settingsBtn').addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
});
document.getElementById('settingsClose').addEventListener('click', () => {
  settingsPanel.hidden = true;
});

concurrencyInput.addEventListener('input', () => {
  document.getElementById('concurrencyValue').textContent = concurrencyInput.value;
});
concurrencyInput.addEventListener('change', () => pushSettings({ startConcurrency: Number(concurrencyInput.value) }));

bufferInput.addEventListener('input', () => {
  document.getElementById('bufferValue').textContent = bufferInput.value;
});
bufferInput.addEventListener('change', () => pushSettings({ bufferMB: Number(bufferInput.value) }));

muteInput.addEventListener('change', () => pushSettings({ muteFrontends: muteInput.checked }));

export const helpPanel = document.getElementById('helpPanel');
const shortcutsToggle = document.getElementById('shortcutsEnabled');
// Exported as a live binding: app.js reads it on every keystroke and an ES module
// import sees the reassignment below, so there is no state to keep in step.
export let shortcutsOn = readPref('shortcutsEnabled', true);
shortcutsToggle.checked = shortcutsOn;

shortcutsToggle.addEventListener('change', () => {
  shortcutsOn = shortcutsToggle.checked;
  writePref('shortcutsEnabled', shortcutsOn);
});

document.getElementById('helpBtn').addEventListener('click', () => {
  helpPanel.hidden = !helpPanel.hidden;
  settingsPanel.hidden = true;
});
document.getElementById('helpClose').addEventListener('click', () => {
  helpPanel.hidden = true;
});

const panels = [
  { panel: settingsPanel, button: document.getElementById('settingsBtn') },
  { panel: helpPanel, button: document.getElementById('helpBtn') },
];

document.addEventListener('mousedown', (event) => {
  for (const { panel, button } of panels) {
    if (panel.hidden) continue;
    if (panel.contains(event.target) || button.contains(event.target)) continue;
    panel.hidden = true;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  // Close a panel first; only then let Escape mean "drop the trace".
  const open = panels.find(({ panel }) => !panel.hidden);
  if (open) {
    open.panel.hidden = true;
    event.stopPropagation();
  }
}, true);

// Opening one panel closes the other.
document.getElementById('settingsBtn').addEventListener('click', () => {
  helpPanel.hidden = true;
});

