// Theme, and the two draggable dividers. Everything here is per-browser.

import { el, rawPref, readPref, writePref } from './core.js';

const themeSelect = document.getElementById('theme');
// Older builds wrote the theme as a bare string rather than JSON, so a value that
// will not parse is read back raw once and rewritten properly below.
const storedTheme = readPref('theme', null) ?? rawPref('theme');

/**
 * Applies a colour theme and remembers it for next time.
 * @param name - the theme key
 */
function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  themeSelect.value = name;
  writePref('theme', name);
}

applyTheme(storedTheme ?? 'black');
themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));

const storedWidth = readPref('detailWidth', 0);

/**
 * Sets the detail pane width and remembers it.
 * @param px - the desired width in pixels
 */
function setDetailWidth(px) {
  const clamped = Math.min(Math.max(px, 320), window.innerWidth - 360);
  el.split.style.setProperty('--detail-width', `${clamped}px`);
  writePref('detailWidth', clamped);
}

if (storedWidth > 0) setDetailWidth(storedWidth);

document.getElementById('resizer').addEventListener('mousedown', (event) => {
  event.preventDefault();
  document.body.style.userSelect = 'none';
  const onMove = (move) => setDetailWidth(window.innerWidth - move.clientX);
  const onUp = () => {
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
});

/**
 * Sets the sidebar width and remembers it for next time.
 * @param px - the desired width in pixels
 */
function setSidebarWidth(px) {
  const clamped = Math.min(Math.max(px, 180), Math.min(560, window.innerWidth - 320));
  document.body.style.setProperty('--sidebar-width', `${clamped}px`);
  writePref('sidebarWidth', clamped);
}

const storedSidebar = readPref('sidebarWidth', 0);
if (storedSidebar > 0) setSidebarWidth(storedSidebar);

document.getElementById('sidebarResizer').addEventListener('mousedown', (event) => {
  event.preventDefault();
  document.body.style.userSelect = 'none';
  const onMove = (move) => setSidebarWidth(move.clientX);
  const onUp = () => {
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
});

