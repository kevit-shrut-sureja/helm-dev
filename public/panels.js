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

export const helpPanel = document.getElementById('helpPanel');
const reportPanel = document.getElementById('reportPanel');
const shortcutsToggle = document.getElementById('shortcutsEnabled');
// Exported as a live binding: app.js reads it on every keystroke and an ES module
// import sees the reassignment below, so there is no state to keep in step.
export let shortcutsOn = readPref('shortcutsEnabled', true);
shortcutsToggle.checked = shortcutsOn;

shortcutsToggle.addEventListener('change', () => {
  shortcutsOn = shortcutsToggle.checked;
  writePref('shortcutsEnabled', shortcutsOn);
});

// Settings, help and the bug report are modal: one at a time, and nothing behind
// them can be reached while one is up. Every way of opening or closing one goes
// through openPanel/closePanel, so focus and the page behind it are handled in a
// single place — a button, `?`, Escape and a click elsewhere all behave alike.
const dialogs = [settingsPanel, helpPanel, reportPanel];
// The control that opened the visible dialog; closing hands focus back to it.
let returnTo = null;
// The last thing outside any dialog that had focus, for a dialog opened by a key.
let lastOutside = null;
// Where the last closed dialog sent focus, for a close that a mouse click interrupts.
let returnToAfterClose = null;

document.addEventListener('focusin', (event) => {
  if (!dialogs.some((panel) => panel.contains(event.target))) lastOutside = event.target;
});

/**
 * Makes the page behind an open dialog unreachable by keyboard and assistive tech.
 * @param modal - true while any dialog is open
 */
function setBackgroundInert(modal) {
  for (const node of document.querySelectorAll('.sidebar, .sidebar-resizer, .main')) node.inert = modal;
}

/**
 * Whether any dialog is showing.
 * @returns the open dialog, or undefined
 */
export function openDialog() {
  return dialogs.find((panel) => !panel.hidden);
}

/**
 * Opens a dialog, closing any other first so they never stack.
 * @param panel - the dialog to show
 * @param opener - the control that asked for it, to return focus to on close
 */
export function openPanel(panel, opener) {
  const outside = dialogs.some((candidate) => candidate.contains(document.activeElement)) ? null : document.activeElement;
  for (const other of dialogs) {
    if (other !== panel) other.hidden = true;
  }
  returnTo = opener ?? (outside && outside !== document.body ? outside : (returnTo ?? lastOutside));
  panel.hidden = false;
  setBackgroundInert(true);
  panel.focus();
}

/**
 * Closes a dialog and puts focus back where it came from.
 * @param panel - the dialog to hide
 */
export function closePanel(panel) {
  if (panel.hidden) return;
  panel.hidden = true;
  setBackgroundInert(false);
  const target = returnTo?.isConnected ? returnTo : lastOutside;
  returnTo = null;
  returnToAfterClose = target;
  if (target?.isConnected) target.focus();
}

/**
 * Opens a dialog, or closes it if it is already the one showing.
 * @param panel - the dialog
 * @param opener - the control that was pressed
 */
export function togglePanel(panel, opener) {
  if (panel.hidden) openPanel(panel, opener);
  else closePanel(panel);
}

const settingsButton = document.getElementById('settingsBtn');
const helpButton = document.getElementById('helpBtn');
settingsButton.addEventListener('click', () => togglePanel(settingsPanel, settingsButton));
helpButton.addEventListener('click', () => togglePanel(helpPanel, helpButton));
document.getElementById('settingsClose').addEventListener('click', () => closePanel(settingsPanel));
document.getElementById('helpClose').addEventListener('click', () => closePanel(helpPanel));

// A click on the dimmed page closes settings and help. The report form is a draft
// someone is mid-way through, so it closes only by its button, its cross or Escape.
document.addEventListener('mousedown', (event) => {
  for (const panel of [settingsPanel, helpPanel]) {
    if (panel.hidden || panel.contains(event.target)) continue;
    if (event.target.closest?.('#settingsBtn, #helpBtn, #reportBtn')) continue;
    closePanel(panel);
    // The click's own default action moves focus to whatever was clicked, after this
    // handler returns; put it back once that has happened.
    const back = returnToAfterClose;
    setTimeout(() => back?.isConnected && back.focus(), 0);
  }
});

// Capture phase, so Escape closes the dialog before anything else sees it.
document.addEventListener(
  'keydown',
  (event) => {
    if (event.key !== 'Escape') return;
    const open = openDialog();
    if (!open) return;
    event.stopImmediatePropagation();
    closePanel(open);
  },
  true,
);

for (const panel of dialogs) {
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const stops = [...panel.querySelectorAll('button:not(:disabled), input:not(:disabled), select, textarea, summary, a[href]')].filter(
      (node) => node.offsetParent !== null,
    );
    if (stops.length === 0) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });
}
