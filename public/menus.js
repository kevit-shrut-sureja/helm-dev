// Popup menus. One is open at a time; each is positioned against the control that
// opened it and closes on Escape, a click elsewhere, Tab, or the page moving
// under it. Focus goes into the menu on open and back to the trigger on Escape.

let current = null;

/**
 * Places a menu beside its trigger, kept inside the window. Menus are fixed
 * rather than absolute because the panes around them clip.
 * @param menu - the menu element, already visible
 * @param trigger - the control it hangs from
 * @param align - 'start' lines up the left edges, 'end' the right ones
 */
function place(menu, trigger, align) {
  const box = trigger.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = align === 'end' ? box.right - width : box.left;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  let top = box.bottom + 4;
  if (top + height > window.innerHeight - 8) top = Math.max(8, box.top - height - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

/**
 * The controls inside a menu that can take focus, in order.
 * @param menu - the menu element
 * @returns the focusable elements
 */
function items(menu) {
  return [...menu.querySelectorAll('[role="menuitem"]:not(:disabled), input, button:not(:disabled)')];
}

/**
 * Whether a given menu is the one currently open.
 * @param menu - the menu element
 * @returns true when it is open
 */
export function isMenuOpen(menu) {
  return current !== null && current.menu === menu;
}

/**
 * Closes whichever menu is open.
 * @param restoreFocus - true to hand focus back to the trigger, as Escape does
 */
export function closeMenu(restoreFocus = false) {
  if (current === null) return;
  const { menu, trigger, onClose } = current;
  current = null;
  menu.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus && trigger.isConnected) trigger.focus();
  onClose?.();
}

/**
 * Opens a menu against a trigger, closing any other first.
 * @param menu - the menu element
 * @param trigger - the control that opened it
 * @param options - `align` ('start' or 'end'), `onClose` called when it shuts
 */
export function openMenu(menu, trigger, options = {}) {
  closeMenu();
  menu.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  current = { menu, trigger, onClose: options.onClose, align: options.align ?? 'start' };
  place(menu, trigger, current.align);
  items(menu)[0]?.focus();
}

/**
 * Points an open menu at a replacement trigger, for when the list that held the
 * old one was redrawn underneath it.
 * @param menu - the menu element
 * @param trigger - the new trigger, or null when its owner is gone
 */
export function retargetMenu(menu, trigger) {
  if (!isMenuOpen(menu)) return;
  if (trigger === null) {
    current.onClose = undefined;
    closeMenu();
    return;
  }
  current.trigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  place(menu, trigger, current.align);
}

// Capture phase, so Escape closes a menu before panels or the detail pane see it.
document.addEventListener(
  'keydown',
  (event) => {
    if (current === null) return;
    if (event.key === 'Escape') {
      event.stopImmediatePropagation();
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      closeMenu();
      return;
    }
    if (!current.menu.contains(event.target) || current.menu.getAttribute('role') !== 'menu') return;
    const list = items(current.menu);
    const at = list.indexOf(document.activeElement);
    let target = null;
    if (event.key === 'ArrowDown') target = list[(at + 1) % list.length];
    else if (event.key === 'ArrowUp') target = list[(at - 1 + list.length) % list.length];
    else if (event.key === 'Home') target = list[0];
    else if (event.key === 'End') target = list[list.length - 1];
    if (!target) return;
    event.preventDefault();
    target.focus();
  },
  true,
);

document.addEventListener(
  'mousedown',
  (event) => {
    if (current === null) return;
    if (current.menu.contains(event.target) || current.trigger.contains(event.target)) return;
    closeMenu();
  },
  true,
);

// A menu pinned to a spot the page has scrolled away from is worse than none. Only
// the sidebar list counts: the log pane scrolls on its own with every new line
// while following, and that must not close a menu someone is reading.
window.addEventListener('resize', () => closeMenu());
document.addEventListener(
  'scroll',
  (event) => {
    if (current === null || current.menu.contains(event.target)) return;
    if (event.target === document || event.target.id === 'services') closeMenu();
  },
  true,
);
