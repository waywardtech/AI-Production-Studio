// The panel's one dialog.
//
// Side panels are extension pages, where native window.prompt/confirm
// are unreliable and visually inconsistent with the panel, so every
// dialog — variables, titles, tags, block management, the optimize
// flow, confirmations — goes through this.
//
// Resolves to an object of field values keyed by field name, or null if
// Dan cancels. A modal with no fields resolves to {} on confirm, which
// is what makes it usable as a confirmation dialog.
//
// Field types: text (default), textarea, select, checkbox.
// `render(container, api)` draws arbitrary extra content — used by the
// block manager, which needs per-row delete buttons.
// `extraButtons` adds actions beside Cancel/Confirm.
// `onOpen(api)` hands control back to the caller so long-running flows
// (the optimize poller) can close the dialog themselves.

const modalEl = document.getElementById('modal');
const modalTitleEl = document.getElementById('modal-title');
const modalBodyEl = document.getElementById('modal-body');
const modalFieldsEl = document.getElementById('modal-fields');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const modalConfirmBtn = document.getElementById('modal-confirm-btn');

export function setModalBody(body) {
  if (body) {
    modalBodyEl.textContent = body;
    modalBodyEl.classList.remove('hidden');
  } else {
    modalBodyEl.classList.add('hidden');
  }
}

function buildInput(field) {
  if (field.type === 'select') {
    const select = document.createElement('select');
    (field.options || []).forEach((opt) => {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      select.appendChild(option);
    });
    select.value = field.value ?? '';
    return select;
  }

  if (field.type === 'textarea') {
    const textarea = document.createElement('textarea');
    textarea.rows = field.rows || 8;
    textarea.value = field.value || '';
    return textarea;
  }

  if (field.type === 'checkbox') {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !!field.value;
    return checkbox;
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.value = field.value || '';
  return input;
}

export function openModal({
  title,
  body = null,
  hint = null,
  fields = [],
  confirmLabel = 'OK',
  danger = false,
  render = null,
  extraButtons = [],
  onOpen = null,
}) {
  return new Promise((resolve) => {
    modalTitleEl.textContent = title;
    setModalBody(body);

    modalFieldsEl.innerHTML = '';
    const inputs = {};

    if (hint) {
      const hintEl = document.createElement('p');
      hintEl.className = 'modal-hint';
      hintEl.textContent = hint;
      modalFieldsEl.appendChild(hintEl);
    }

    fields.forEach((field) => {
      const wrapper = document.createElement('div');
      wrapper.className = field.mono ? 'variable-field mono' : 'variable-field';

      const label = document.createElement('label');
      label.textContent = field.label;
      wrapper.appendChild(label);

      const input = buildInput(field);
      inputs[field.name] = input;
      wrapper.appendChild(input);
      modalFieldsEl.appendChild(wrapper);
    });

    if (render) render(modalFieldsEl, { confirm: onConfirm, cancel: onCancel });

    modalConfirmBtn.textContent = confirmLabel;
    modalConfirmBtn.classList.toggle('danger', danger);

    const extraEls = [];
    extraButtons.forEach((spec) => {
      const btn = document.createElement('button');
      btn.className = 'secondary';
      btn.textContent = spec.label;
      btn.addEventListener('click', () =>
        spec.onClick({ getValues, confirm: onConfirm, cancel: onCancel })
      );
      modalConfirmBtn.parentNode.insertBefore(btn, modalConfirmBtn);
      extraEls.push(btn);
    });

    modalEl.classList.remove('hidden');

    const firstField = fields.find((f) => f.type !== 'checkbox');
    const firstInput = firstField ? inputs[firstField.name] : null;
    if (firstInput) {
      firstInput.focus();
      // A prefilled value should be easy to replace.
      if (typeof firstInput.select === 'function') firstInput.select();
    } else {
      modalConfirmBtn.focus();
    }

    function getValues() {
      const values = {};
      fields.forEach((field) => {
        const input = inputs[field.name];
        values[field.name] = field.type === 'checkbox' ? input.checked : input.value;
      });
      return values;
    }

    function cleanup() {
      modalEl.classList.add('hidden');
      modalConfirmBtn.classList.remove('danger');
      extraEls.forEach((el) => el.remove());
      modalConfirmBtn.removeEventListener('click', onConfirm);
      modalCancelBtn.removeEventListener('click', onCancel);
      modalEl.removeEventListener('keydown', onKeydown);
    }

    let settled = false;

    function onConfirm() {
      if (settled) return;
      settled = true;
      const values = getValues();
      cleanup();
      resolve(values);
    }

    function onCancel() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    }

    function onKeydown(e) {
      if (e.key === 'Escape') onCancel();
      // Enter submits from a single-line input only — not from a
      // textarea, where it has to keep inserting newlines.
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type === 'text') onConfirm();
    }

    modalConfirmBtn.addEventListener('click', onConfirm);
    modalCancelBtn.addEventListener('click', onCancel);
    modalEl.addEventListener('keydown', onKeydown);

    if (onOpen) onOpen({ confirm: onConfirm, cancel: onCancel, setBody: setModalBody, getValues });
  });
}
