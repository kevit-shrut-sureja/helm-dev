// The bug report form: collect a title, a description and screenshots, show what
// helm-dev will add on its own, and hand it to the server to file as an issue.

import { post, state } from './core.js';
import { closePanel, openPanel } from './panels.js';

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const panel = document.getElementById('reportPanel');
const form = document.getElementById('reportForm');
const done = document.getElementById('reportDone');
const category = document.getElementById('reportCategory');
const title = document.getElementById('reportTitle');
const description = document.getElementById('reportDesc');
const shots = document.getElementById('reportShots');
const fileInput = document.getElementById('reportFile');
const errorLine = document.getElementById('reportError');
const sendButton = document.getElementById('reportSend');
const busy = document.getElementById('reportBusy');
const meta = document.getElementById('reportMeta');
const preview = document.getElementById('reportPreview');

let images = [];
// Sending needs a destination that answered and nothing already in flight.
let targetReady = false;
let sending = false;

/**
 * Enables Send only when a report could actually be filed right now.
 */
function syncSend() {
  sendButton.disabled = !targetReady || sending;
}

/**
 * Describes the log pane's filters, so a report says what the reporter was
 * looking at. What was typed into the search box is deliberately left out.
 * @returns the view the server writes into the report
 */
function currentView() {
  return {
    showNoise: state.showNoise,
    hiddenLevels: ['error', 'warn', 'info', 'debug', 'raw'].filter((level) => !state.levels.has(level)),
    focusCount: state.focus.size,
    trace: state.trace?.key ?? null,
    hasSearch: state.search.length > 0,
    cleared: state.hiddenBelow > 0,
  };
}

/**
 * Draws the thumbnails of the screenshots chosen so far.
 */
function renderShots() {
  shots.replaceChildren();
  for (const [index, image] of images.entries()) {
    const box = document.createElement('div');
    box.className = 'report-shot';
    const thumbnail = document.createElement('img');
    thumbnail.src = image.preview;
    thumbnail.alt = image.name;
    const remove = document.createElement('button');
    remove.className = 'mini';
    remove.textContent = '\u00d7';
    remove.title = 'remove this screenshot';
    remove.addEventListener('click', () => {
      URL.revokeObjectURL(image.preview);
      images.splice(index, 1);
      renderShots();
    });
    box.append(thumbnail, remove);
    shots.append(box);
  }
  document.getElementById('reportAddShot').disabled = images.length >= MAX_IMAGES;
}

/**
 * Reads an image file into the form, refusing what the server would refuse.
 * @param file - an image File from the picker or the clipboard
 */
async function addImage(file) {
  errorLine.textContent = '';
  if (images.length >= MAX_IMAGES) {
    errorLine.textContent = `At most ${MAX_IMAGES} screenshots.`;
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    errorLine.textContent = `${file.name || 'That image'} is over ${MAX_IMAGE_BYTES / 1024 / 1024}MB.`;
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  // btoa takes a string, and building one from a few megabytes in a single call
  // overflows the argument limit, so it is assembled in slices.
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  images.push({ name: file.name || 'pasted image', type: file.type, data: btoa(binary), preview: URL.createObjectURL(file) });
  renderShots();
}

/**
 * Loads the destination and categories, and says up front if reports cannot be
 * sent from this machine — before anyone has written a paragraph.
 */
async function loadTarget() {
  const note = document.getElementById('reportTarget');
  const retry = document.getElementById('reportRetry');
  targetReady = false;
  retry.hidden = true;
  syncSend();
  note.classList.remove('panel-error');
  note.textContent = 'Checking where reports go…';
  let info;
  try {
    const response = await fetch('/api/report');
    if (!response.ok) throw new Error(`status ${response.status}`);
    info = await response.json();
  } catch {
    // What was typed stays; only the ability to send is withdrawn until helm-dev
    // answers, because a click that cannot succeed is worse than a disabled one.
    note.classList.add('panel-error');
    note.textContent = 'Could not reach helm-dev to check where reports go, so sending is off for now.';
    retry.hidden = false;
    if (category.options.length === 0) category.add(new Option('Unavailable — helm-dev did not answer', '', true, true));
    return;
  }
  if (category.options.length === 0 || category.options[0].value === '') {
    category.replaceChildren();
    for (const name of info.categories ?? []) category.add(new Option(name, name));
  }
  if (!info.ready) {
    note.textContent = info.reason;
    note.classList.add('panel-error');
    return;
  }
  targetReady = true;
  syncSend();
  note.textContent =
    `This files an issue in ${info.repo} as your GitHub account, through the gh tool.` +
    `${info.visibility === 'public' ? ' That repository is public, so anyone can read the report and its screenshots — leave out anything private.' : ''}`;
}

/**
 * Fills the "added automatically" block with what the server would send now.
 */
async function loadPreview() {
  preview.textContent = 'loading…';
  const result = await post('/api/report/preview', { category: category.value, view: currentView() });
  preview.textContent = result.metadata ?? result.error ?? 'could not load';
}

/**
 * Opens the form. Anything already typed is kept, so switching away to settings
 * and back does not cost a half-written report.
 * @param opener - the control that was pressed, to return focus to on close
 */
function openReport(opener) {
  form.hidden = false;
  done.hidden = true;
  errorLine.textContent = '';
  openPanel(panel, opener);
  loadTarget();
  if (meta.open) loadPreview().catch(() => undefined);
  title.focus();
}

/**
 * Sends the report and shows the issue it became.
 */
async function sendReport() {
  errorLine.textContent = '';
  sending = true;
  syncSend();
  busy.hidden = false;
  try {
    const result = await post('/api/report', {
      title: title.value,
      description: description.value,
      category: category.value,
      view: currentView(),
      images: images.map(({ name, type, data }) => ({ name, type, data })),
    });
    if (result.error) {
      errorLine.textContent = result.error;
      return;
    }
    const link = document.getElementById('reportLink');
    link.href = result.url;
    link.textContent = result.url;
    document.getElementById('reportWarning').textContent = (result.warnings ?? []).join(' ');
    form.hidden = true;
    done.hidden = false;
    title.value = '';
    description.value = '';
    for (const image of images) URL.revokeObjectURL(image.preview);
    images = [];
    renderShots();
  } catch (error) {
    errorLine.textContent = `Could not send: ${error.message}`;
  } finally {
    sending = false;
    syncSend();
    busy.hidden = true;
  }
}

const reportButton = document.getElementById('reportBtn');
reportButton.addEventListener('click', () => {
  if (panel.hidden) openReport(reportButton);
  else closePanel(panel);
});
document.getElementById('reportClose').addEventListener('click', () => closePanel(panel));
document.getElementById('reportAnother').addEventListener('click', () => openReport());
document.getElementById('reportRetry').addEventListener('click', () => loadTarget());
document.getElementById('reportAddShot').addEventListener('click', () => fileInput.click());
sendButton.addEventListener('click', () => sendReport());

fileInput.addEventListener('change', async () => {
  for (const file of fileInput.files) await addImage(file);
  fileInput.value = '';
});

description.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
  if (files.length === 0) return;
  event.preventDefault();
  for (const file of files) addImage(file);
});

meta.addEventListener('toggle', () => {
  if (meta.open) loadPreview().catch(() => undefined);
});
category.addEventListener('change', () => {
  if (meta.open) loadPreview().catch(() => undefined);
});
