// Adding, removing and reordering the repositories being watched.

import { el, escapeHtml, post, state } from './core.js';
import { renderServices } from './services.js';

/**
 * Shortens a path for display, since the home prefix is the same on every row.
 * @param path - the absolute path
 * @returns the path with the home directory replaced by ~
 */
function shortPath(path) {
  const home = state.home ?? '';
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * Lists the registered workspaces in the settings panel, each removable.
 */
export function renderWorkspaceList() {
  const list = document.getElementById('workspaceList');
  list.innerHTML = state.workspaces
    .map(
      (workspace) => `<div class="workspace-row">
        <span class="workspace-name">${escapeHtml(workspace.name)}</span>
        <span class="workspace-path" title="${escapeHtml(workspace.root)}">${escapeHtml(shortPath(workspace.root))}</span>
        <button class="mini" data-remove="${escapeHtml(workspace.name)}" title="stop watching this workspace">&times;</button>
      </div>`,
    )
    .join('');
}

document.getElementById('workspaceList').addEventListener('click', async (event) => {
  const name = event.target.dataset?.remove;
  if (!name) return;
  if (!confirm(`Stop watching "${name}"? Its running services are stopped. The repository itself is untouched.`)) return;
  await post('/api/repos/remove', { name });
  window.location.reload();
});

document.getElementById('addRepo').addEventListener('click', async () => {
  const error = document.getElementById('addRepoError');
  const path = document.getElementById('newRepoPath').value.trim();
  error.textContent = '';
  if (path.length === 0) return;
  const result = await post('/api/repos', { path, name: document.getElementById('newRepoName').value });
  if (result.error) {
    error.textContent = result.error;
    return;
  }
  window.location.reload();
});

let draggedRepo = null;

el.services.addEventListener('dragstart', (event) => {
  const section = event.target.closest('.repo-section');
  if (!section) return;
  draggedRepo = section.dataset.repo;
  section.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
});

el.services.addEventListener('dragend', () => {
  draggedRepo = null;
  for (const section of el.services.querySelectorAll('.repo-section')) {
    section.classList.remove('dragging', 'drop-target');
  }
});

el.services.addEventListener('dragover', (event) => {
  const section = event.target.closest('.repo-section');
  if (!section || draggedRepo === null || section.dataset.repo === draggedRepo) return;
  event.preventDefault();
  for (const other of el.services.querySelectorAll('.repo-section')) other.classList.remove('drop-target');
  section.classList.add('drop-target');
});

el.services.addEventListener('drop', async (event) => {
  const section = event.target.closest('.repo-section');
  if (!section || draggedRepo === null) return;
  event.preventDefault();
  const target = section.dataset.repo;
  if (target === draggedRepo) return;

  const order = state.workspaces.map((workspace) => workspace.name);
  order.splice(order.indexOf(draggedRepo), 1);
  order.splice(order.indexOf(target), 0, draggedRepo);

  // Reorder locally first so the list does not jump while the server catches up.
  state.workspaces.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  renderServices();
  await post('/api/repos/order', { order });
});
