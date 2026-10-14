// Theme, density, and the room the three panes share. Everything here is
// per-browser.

import { syncInspector } from './detail.js';
import { applyDensity } from './logs.js';
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

/* ---------- density ---------- */

const DENSITIES = ['readable', 'compact'];
const densitySelect = document.getElementById('density');

/**
 * Applies a density. The stylesheet changes the row height; the log pane then
 * reads it and re-lays itself out around the line the viewer was on.
 * @param name - 'readable' or 'compact'; anything else means readable
 */
function setDensity(name) {
  const density = DENSITIES.includes(name) ? name : 'readable';
  document.documentElement.dataset.density = density;
  densitySelect.value = density;
  writePref('density', density);
  applyDensity();
}

setDensity(readPref('density', 'readable'));
densitySelect.addEventListener('change', () => setDensity(densitySelect.value));

/* ---------- pane budget ---------- */

// Widths are in CSS pixels. The log pane is what the other two answer to: the
// inspector docks beside it only while it can leave the logs LOGS_MIN, and
// floats over them otherwise.
const SIDEBAR_MIN = 260;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 304;
const DETAIL_MIN = 380;
const DETAIL_MAX = 960;
const DETAIL_DEFAULT = 480;
const LOGS_MIN = 560;
const DIVIDER = 1;
// The same two breakpoints are in layout.css. Below the first the sidebar can be
// folded away; below the second it floats over the page instead of taking room.
const COLLAPSE_BELOW = 1100;
const OVERLAY_BELOW = 800;

const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');
const sidebarResizer = document.getElementById('sidebarResizer');
const detailResizer = document.getElementById('resizer');

// What the viewer chose, kept apart from what fits: shrinking the window must not
// forget a wide setting, so layout() clamps these on every pass and never writes
// the clamped result back.
let sidebarPref = clamp(readPref('sidebarWidth', 0) || SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX);
let detailPref = clamp(readPref('detailWidth', 0) || DETAIL_DEFAULT, DETAIL_MIN, DETAIL_MAX);
// null until the viewer opens or closes it, so the width of the window decides.
let sidebarOpen = null;
let band = null;

/**
 * Keeps a number inside a range; the minimum wins if the range is inverted.
 * @param value - the number
 * @param low - the smallest allowed
 * @param high - the largest allowed
 * @returns the clamped number
 */
function clamp(value, low, high) {
  return Math.max(low, Math.min(value, high));
}

/**
 * Splits the window width among the sidebar, the log pane and the inspector, and
 * writes the result where the stylesheet and the dividers read it. Runs on load,
 * on every resize and after every drag, so a saved width that no longer fits is
 * corrected before it can leave the logs a sliver.
 */
function layout() {
  const width = window.innerWidth;
  const nextBand = width >= COLLAPSE_BELOW ? 'wide' : width >= OVERLAY_BELOW ? 'mid' : 'narrow';
  // Crossing a breakpoint hands the decision back to the window.
  if (nextBand !== band) sidebarOpen = null;
  band = nextBand;

  const showSidebar = band === 'wide' || (sidebarOpen ?? band === 'mid');
  const floatingSidebar = band === 'narrow';
  document.body.dataset.sidebar = showSidebar ? 'open' : 'closed';
  sidebarToggle.setAttribute('aria-expanded', String(showSidebar));
  sidebar.setAttribute('role', floatingSidebar && showSidebar ? 'dialog' : 'complementary');
  if (floatingSidebar && showSidebar) sidebar.setAttribute('aria-modal', 'true');
  else sidebar.removeAttribute('aria-modal');

  const sidebarMax = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, width - LOGS_MIN - DIVIDER));
  const sidebarWidth = clamp(sidebarPref, SIDEBAR_MIN, sidebarMax);
  document.body.style.setProperty('--sidebar-width', `${sidebarWidth}px`);

  const docked = showSidebar && !floatingSidebar;
  const mainWidth = width - (docked ? sidebarWidth + DIVIDER : 0);
  const room = mainWidth - LOGS_MIN - DIVIDER;
  const beside = room >= DETAIL_MIN;
  el.split.dataset.inspector = beside ? 'side' : 'overlay';
  const detailWidth = beside ? clamp(detailPref, DETAIL_MIN, room) : clamp(detailPref, DETAIL_MIN, Math.max(DETAIL_MIN, mainWidth));
  el.split.style.setProperty('--detail-width', `${detailWidth}px`);
  syncInspector();

  describe(sidebarResizer, SIDEBAR_MIN, sidebarMax, sidebarWidth);
  describe(detailResizer, DETAIL_MIN, Math.max(DETAIL_MIN, room), detailWidth);
}

/**
 * Tells assistive technology what a divider currently controls.
 * @param separator - the divider element
 * @param low - the smallest width it allows right now
 * @param high - the largest width it allows right now
 * @param now - the width it has
 */
function describe(separator, low, high, now) {
  separator.setAttribute('aria-valuemin', String(low));
  separator.setAttribute('aria-valuemax', String(high));
  separator.setAttribute('aria-valuenow', String(Math.round(now)));
}

/**
 * Makes a divider draggable with the pointer and operable from the keyboard.
 * @param separator - the divider element
 * @param options - `read` the chosen width, `write` to store a new one, `grows` the
 *   key that widens the pane, `fromPointer` pointer x to width, `min` and `max` for Home and End
 */
function wireDivider(separator, options) {
  const { grows, min, max } = options;
  separator.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    separator.setPointerCapture(event.pointerId);
    separator.classList.add('dragging');
    document.body.style.userSelect = 'none';
    const onMove = (move) => {
      options.write(options.fromPointer(move.clientX));
      layout();
    };
    const onUp = () => {
      separator.classList.remove('dragging');
      document.body.style.userSelect = '';
      separator.removeEventListener('pointermove', onMove);
      separator.removeEventListener('pointerup', onUp);
      separator.removeEventListener('pointercancel', onUp);
    };
    separator.addEventListener('pointermove', onMove);
    separator.addEventListener('pointerup', onUp);
    separator.addEventListener('pointercancel', onUp);
  });

  separator.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 64 : 16;
    const shrinks = grows === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight';
    let next = null;
    if (event.key === grows) next = options.read() + step;
    else if (event.key === shrinks) next = options.read() - step;
    else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    // Step from what is on screen, not from a stored width the window overrode.
    options.write(next);
    layout();
  });
}

wireDivider(sidebarResizer, {
  read: () => Number(sidebarResizer.getAttribute('aria-valuenow')),
  write: (px) => {
    sidebarPref = clamp(px, SIDEBAR_MIN, SIDEBAR_MAX);
    writePref('sidebarWidth', sidebarPref);
  },
  grows: 'ArrowRight',
  fromPointer: (x) => x,
  min: SIDEBAR_MIN,
  max: SIDEBAR_MAX,
});

wireDivider(detailResizer, {
  read: () => Number(detailResizer.getAttribute('aria-valuenow')),
  write: (px) => {
    detailPref = clamp(px, DETAIL_MIN, DETAIL_MAX);
    writePref('detailWidth', detailPref);
  },
  grows: 'ArrowLeft',
  fromPointer: (x) => window.innerWidth - x,
  min: DETAIL_MIN,
  max: DETAIL_MAX,
});

/**
 * Opens or folds the sidebar, and puts focus where the viewer will expect it.
 * @param open - true to show it
 */
function setSidebar(open) {
  sidebarOpen = open;
  layout();
  if (band !== 'narrow') return;
  if (open) sidebar.querySelector('button, input')?.focus();
  else sidebarToggle.focus();
}

sidebarToggle.addEventListener('click', () => setSidebar(document.body.dataset.sidebar !== 'open'));

// A floating sidebar is modal in effect: Escape or a click on the page behind it
// closes it, and neither goes on to do anything else.
document.addEventListener(
  'keydown',
  (event) => {
    if (event.key !== 'Escape' || band !== 'narrow' || document.body.dataset.sidebar !== 'open') return;
    event.stopImmediatePropagation();
    setSidebar(false);
  },
  true,
);
document.addEventListener(
  'click',
  (event) => {
    if (band !== 'narrow' || document.body.dataset.sidebar !== 'open') return;
    if (sidebar.contains(event.target) || sidebarToggle.contains(event.target)) return;
    event.stopPropagation();
    event.preventDefault();
    setSidebar(false);
  },
  true,
);

window.addEventListener('resize', layout);
layout();
