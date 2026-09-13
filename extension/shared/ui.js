// Panel-level UI shared by every section: toasts, the Prompts/Replies
// tab switch, and the clipboard.

const toastEl = document.getElementById('toast');

let toastTimer = null;

export function showToast(message, kind = 'success') {
  toastEl.textContent = message;
  toastEl.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, 4500);
}

export function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `tab-${name}`);
  });
}

export function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error('[Edge Studio] Clipboard write failed:', err);
    return false;
  }
}

// Uses the highlighted part of a textarea if there is one, the whole
// value otherwise. This is what makes "turn this bit into a prompt"
// work without a separate selection mode.
export function selectedTextOf(textarea) {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  if (start !== end) return value.slice(start, end).trim();
  return value.trim();
}
