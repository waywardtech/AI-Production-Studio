// Choosing which project files go with the next Insert (M5-4).
//
// The studio attaches a shot's own references automatically, because a
// shot knows what it is about. A prompt doesn't, so here the files are
// picked by hand, and the choice is shown under the builder until it's
// used or cleared.
//
// Only files whose bytes are on this machine can be listed: an asset
// imported on another computer, or one too big to hold, has nothing to
// hand over. Those are named rather than silently missing.

import { state } from './state.js';
import { list } from '../../shared/store.js';
import { openModal } from '../../shared/modal.js';
import { showToast } from '../../shared/ui.js';
import { attachableFiles } from '../../shared/attach.js';
import { blobs, formatBytes } from '../../shared/blobs.js';

const lineEl = document.getElementById('attachment-line');
const clearBtn = document.getElementById('clear-attachments-btn');

export async function chosenAttachments() {
  if (state.attachmentAssetIds.size === 0) return { ready: [], missing: [] };
  const assets = (await list('assets', { projectId: state.projectId })).filter((asset) =>
    state.attachmentAssetIds.has(asset.id)
  );
  return attachableFiles(assets);
}

export function clearAttachments() {
  state.attachmentAssetIds.clear();
  renderAttachmentLine();
}

export async function renderAttachmentLine() {
  const count = state.attachmentAssetIds.size;
  clearBtn.classList.toggle('hidden', count === 0);
  lineEl.classList.toggle('hidden', count === 0);
  if (count === 0) return;

  const { ready } = await chosenAttachments();
  const bytes = ready.reduce((sum, file) => sum + file.blob.size, 0);
  lineEl.textContent = `${ready.length} file${ready.length === 1 ? '' : 's'} will go with this prompt · ${formatBytes(bytes)}`;
}

export async function openAttachmentPicker() {
  if (!state.projectId) {
    showToast('No project is active yet.', 'warning');
    return;
  }

  const assets = await list('assets', { projectId: state.projectId });
  const withFiles = assets.filter((asset) => asset.fileRef?.blobId);

  if (withFiles.length === 0) {
    showToast('No files in this project yet — import some in the production workspace.', 'warning');
    return;
  }

  // Asking the byte store directly, because an asset record's own
  // `stored` flag describes the machine that imported it.
  const held = new Set(await blobs.keys());
  const picked = new Set(state.attachmentAssetIds);

  const result = await openModal({
    title: 'Attach files',
    hint: 'These go into the chat alongside the prompt. Nothing is sent — they wait in the composer with it.',
    confirmLabel: 'Use these',
    render: (container) => {
      const listEl = document.createElement('div');
      listEl.className = 'attach-list';

      withFiles.forEach((asset) => {
        const available = held.has(asset.fileRef.blobId);
        const row = document.createElement('label');
        row.className = 'attach-row';
        row.classList.toggle('unavailable', !available);

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = picked.has(asset.id);
        box.disabled = !available;
        box.addEventListener('change', () => {
          if (box.checked) picked.add(asset.id);
          else picked.delete(asset.id);
        });
        row.appendChild(box);

        const name = document.createElement('span');
        name.className = 'attach-name';
        name.textContent = asset.name;
        row.appendChild(name);

        const meta = document.createElement('span');
        meta.className = 'attach-meta';
        meta.textContent = available
          ? `${asset.fileRef.kind || 'file'} · ${formatBytes(asset.fileRef.size)}`
          : asset.fileRef.tooLarge
            ? 'too big to attach'
            : 'not on this machine';
        row.appendChild(meta);

        listEl.appendChild(row);
      });

      container.appendChild(listEl);
    },
  });
  if (result === null) return;

  state.attachmentAssetIds = picked;
  await renderAttachmentLine();
}

export function initAttachments() {
  document.getElementById('attach-btn').addEventListener('click', openAttachmentPicker);
  clearBtn.addEventListener('click', clearAttachments);
}
