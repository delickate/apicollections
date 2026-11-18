'use strict';

/* Sign-in / registration screen. Calls onSignedIn(user) when done. */
const AuthScreen = {
  init(onSignedIn) {
    this.onSignedIn = onSignedIn;
    const view = document.getElementById('auth-view');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');

    view.querySelectorAll('[data-auth-tab]').forEach((tab) => {
      tab.addEventListener('click', () => this.showTab(tab.dataset.authTab));
    });

    loginForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit(loginForm, (values) => window.desktop.session.login(values));
    });

    registerForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit(registerForm, (values) => window.desktop.session.register(values));
    });

    document.getElementById('server-settings-btn').addEventListener('click', () => this.editServer());
    this.refreshServerLabel();
  },

  show() {
    document.getElementById('app-view').hidden = true;
    document.getElementById('auth-view').hidden = false;
    this.showTab('login');
    document.querySelectorAll('#auth-view form').forEach((form) => {
      form.querySelector('[name=password]').value = '';
      form.querySelector('[data-error]').textContent = '';
    });
  },

  showTab(name) {
    document.querySelectorAll('#auth-view [data-auth-tab]').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.authTab === name);
    });
    document.getElementById('login-form').hidden = name !== 'login';
    document.getElementById('register-form').hidden = name !== 'register';
    const form = document.getElementById(`${name}-form`);
    setTimeout(() => form.querySelector('input')?.focus(), 0);
  },

  async submit(form, send) {
    const error = form.querySelector('[data-error]');
    const button = form.querySelector('button[type=submit]');
    const values = Object.fromEntries(new FormData(form).entries());
    values.phone = String(values.phone || '').replace(/[\s()-]/g, '');

    if (!/^\+[1-9][0-9]{7,14}$/.test(values.phone)) {
      error.textContent = 'Enter the phone number in international format, e.g. +923001234567.';
      return;
    }
    if (!values.password) {
      error.textContent = 'Enter your password.';
      return;
    }

    error.textContent = '';
    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'Please wait…';
    try {
      const result = await send(values);
      if (!result.ok) {
        error.textContent = firstError(result.data, 'Something went wrong. Please try again.');
        return;
      }
      this.onSignedIn(result.user);
    } catch (exception) {
      error.textContent = exception.message;
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  },

  async refreshServerLabel() {
    const settings = await window.desktop.settings.get();
    document.getElementById('server-label').textContent = settings.apiBaseUrl;
  },

  async editServer() {
    const settings = await window.desktop.settings.get();
    const value = await openModal((close) => {
      const input = h('input', { type: 'url', value: settings.apiBaseUrl, autofocus: true, spellcheck: false });
      const error = h('div', { class: 'form-error' });
      return h('form', { class: 'modal', onsubmit: async (event) => {
        event.preventDefault();
        try {
          await window.desktop.settings.set({ apiBaseUrl: input.value });
          close(true);
        } catch (exception) {
          error.textContent = exception.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        }
      } },
        h('h3', {}, 'Server address'),
        h('p', {}, 'The API base URL, ending in /api.'),
        h('label', {}, 'API base URL', input),
        error,
        h('div', { class: 'modal-actions' },
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { input.value = settings.defaultApiBaseUrl; } }, 'Use default'),
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close(null) }, 'Cancel'),
          h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save')));
    });
    if (value) this.refreshServerLabel();
  },
};
