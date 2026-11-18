'use strict';

/* Small DOM + UI helpers shared by every screen. Text is always set with
 * textContent so nothing from a collection or response can inject markup. */

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null) continue;
    if (value === false && !(key in el)) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const ICON_PATHS = {
  chevron: '<path d="m9 6 6 6-6 6"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderOpen: '<path d="M3 7V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3 9h18l-2 9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderPlus: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>',
  collection: '<path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M8 3v18"/><path d="M12 8h4M12 12h4"/>',
  collectionPlus: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M12 8v8M8 12h8"/>',
  request: '<path d="M4 12h12M12 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  upload: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.innerHTML = ICON_PATHS[name] || '';
  return svg;
}

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'id' + Date.now() + Math.random().toString(16).slice(2));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Pretty JSON with syntax colours. Input is escaped before any markup is added. */
function highlightJson(jsonText) {
  const escaped = escapeHtml(jsonText);
  return escaped.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = 'j-num';
      if (match.startsWith('"')) cls = match.trimEnd().endsWith(':') ? 'j-key' : 'j-str';
      else if (match === 'true' || match === 'false') cls = 'j-bool';
      else if (match === 'null') cls = 'j-null';
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* ---------------- toasts ---------------- */

function toast(message, type = 'info') {
  const el = h('div', { class: `toast ${type === 'error' ? 'error' : ''}`, role: 'status' }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3200);
}

/* ---------------- modal dialogs ---------------- */

function openModal(build) {
  const backdrop = document.getElementById('modal');
  return new Promise((resolve) => {
    const close = (value) => {
      backdrop.hidden = true;
      backdrop.replaceChildren();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(null);
      }
    };
    const modal = build(close);
    backdrop.replaceChildren(modal);
    backdrop.hidden = false;
    backdrop.onmousedown = (event) => {
      if (event.target === backdrop) close(null);
    };
    document.addEventListener('keydown', onKey, true);
    const focusTarget = modal.querySelector('[autofocus]') || modal.querySelector('input, select, textarea, button.btn-primary, button.btn-danger');
    setTimeout(() => {
      focusTarget?.focus();
      if (focusTarget?.select) focusTarget.select();
    }, 0);
  });
}

function promptDialog({ title, label, value = '', placeholder = '', confirmText = 'Save' }) {
  return openModal((close) => {
    const input = h('input', { type: 'text', value, placeholder, maxlength: '160', autofocus: true });
    const form = h('form', { class: 'modal', onsubmit: (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (text) close(text);
      else input.focus();
    } },
      h('h3', {}, title),
      h('label', {}, label, input),
      h('div', { class: 'modal-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close(null) }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn btn-primary' }, confirmText)));
    return form;
  });
}

function confirmDialog({ title, message, confirmText = 'Delete', danger = true }) {
  return openModal((close) => h('div', { class: 'modal' },
    h('h3', {}, title),
    h('p', {}, message),
    h('div', { class: 'modal-actions' },
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close(false) }, 'Cancel'),
      h('button', { type: 'button', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => close(true) }, confirmText))))
    .then((result) => result === true);
}

/* ---------------- context menu ---------------- */

const contextMenu = {
  el: null,
  open(x, y, items) {
    this.el = this.el || document.getElementById('context-menu');
    const buttons = [];
    this.el.replaceChildren(...items.filter(Boolean).map((item) => {
      if (item === '-') return h('hr');
      const button = h('button', {
        type: 'button',
        class: item.danger ? 'danger' : '',
        onclick: () => {
          this.close();
          item.action();
        },
      }, icon(item.icon || 'request'), item.label);
      buttons.push(button);
      return button;
    }));
    this.el.hidden = false;
    const rect = this.el.getBoundingClientRect();
    this.el.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
    this.el.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
    buttons[0]?.focus();
  },
  close() {
    if (this.el) this.el.hidden = true;
  },
};

document.addEventListener('mousedown', (event) => {
  if (contextMenu.el && !contextMenu.el.hidden && !contextMenu.el.contains(event.target)) contextMenu.close();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') contextMenu.close();
});
window.addEventListener('blur', () => contextMenu.close());

/* ---------------- backend API ---------------- */

class ApiError extends Error {
  constructor(message, status, errors) {
    super(message);
    this.status = status;
    this.errors = errors || {};
  }
}

function firstError(data, fallback) {
  if (data?.errors && typeof data.errors === 'object') {
    const first = Object.values(data.errors).flat()[0];
    if (first) return String(first);
  }
  return data?.message ? String(data.message) : fallback;
}

async function api(method, path, body) {
  const result = await window.desktop.backend({ method, path, body });
  if (!result.ok) {
    throw new ApiError(firstError(result.data, `Request failed (${result.status}).`), result.status, result.data?.errors);
  }
  return result.data;
}
