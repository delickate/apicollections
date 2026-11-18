'use strict';

/* App start-up: shows the login screen or the workspace, and wires global shortcuts. */
const App = {
  user: null,

  async start() {
    AuthScreen.init((user) => this.enter(user));
    window.desktop.session.onExpired(() => {
      if (!this.user) return;
      toast('Your session has expired. Please sign in again.', 'error');
      this.leave();
    });

    this.initChrome();

    const session = await window.desktop.session.get();
    if (session?.user) await this.enter(session.user);
    else AuthScreen.show();
  },

  async enter(user) {
    this.user = user;
    document.getElementById('auth-view').hidden = true;
    document.getElementById('app-view').hidden = false;
    document.getElementById('user-name').textContent = user.name;
    document.getElementById('user-avatar').textContent = initials(user.name);
    document.getElementById('tree').replaceChildren(h('div', { class: 'tree-empty' }, 'Loading your workspace…'));
    Editor.render();

    try {
      await WS.load();
      await Editor.restoreTabs();
    } catch (error) {
      toast(`Could not load your workspace: ${error.message}`, 'error');
      Editor.render();
    }
  },

  async leave() {
    this.user = null;
    WS.reset();
    Editor.closeAll();
    AuthScreen.show();
  },

  async logout() {
    const dirty = Editor.tabs.filter((tab) => Editor.isDirty(tab));
    if (dirty.length) {
      const ok = await confirmDialog({
        title: 'Sign out?',
        message: `${dirty.length} tab${dirty.length === 1 ? ' has' : 's have'} unsaved changes that will be lost.`,
        confirmText: 'Sign out',
      });
      if (!ok) return;
    }
    await window.desktop.session.logout();
    this.leave();
  },

  initChrome() {
    document.getElementById('new-folder-btn').addEventListener('click', () => WS.newFolder(null));
    document.getElementById('new-collection-btn').addEventListener('click', () => WS.newCollection(null));
    document.getElementById('import-btn').addEventListener('click', () => WS.importFiles(null));

    const filter = document.getElementById('tree-filter');
    filter.addEventListener('input', debounce(() => {
      WS.filter = filter.value;
      // Load unopened collections (up to a limit) so their requests are searchable.
      if (WS.filter.trim()) {
        [...WS.collections.keys()].filter((id) => !WS.full.has(id)).slice(0, 40).forEach((id) => WS.ensureCollection(id));
      }
      WS.render();
    }, 150));

    WS.initRootDrop();

    const userChip = document.getElementById('user-chip');
    const openUserMenu = () => {
      const rect = userChip.getBoundingClientRect();
      contextMenu.open(rect.right - 220, rect.bottom + 6, [
        { label: 'Reload workspace', icon: 'refresh', action: () => this.reload() },
        '-',
        { label: 'Sign out', icon: 'logout', danger: true, action: () => this.logout() },
      ]);
    };
    userChip.addEventListener('click', openUserMenu);
    userChip.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') openUserMenu();
    });

    // Sidebar resizing.
    const resizer = document.getElementById('resizer');
    const workspace = document.querySelector('.workspace');
    try {
      const width = Number(localStorage.getItem('sidebar-width'));
      if (width) workspace.style.setProperty('--sidebar-w', `${width}px`);
    } catch {
      /* ignore */
    }
    resizer.addEventListener('mousedown', (event) => {
      event.preventDefault();
      resizer.classList.add('dragging');
      let width;
      const move = (e) => {
        width = Math.max(220, Math.min(560, e.clientX));
        workspace.style.setProperty('--sidebar-w', `${width}px`);
      };
      const up = () => {
        resizer.classList.remove('dragging');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        try {
          if (width) localStorage.setItem('sidebar-width', String(width));
        } catch {
          /* ignore */
        }
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    // Keyboard shortcuts.
    document.addEventListener('keydown', (event) => {
      if (!this.user || !document.getElementById('modal').hidden) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        Editor.save();
      } else if (mod && event.key === 'Enter') {
        event.preventDefault();
        Editor.send();
      } else if (mod && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        if (Editor.activeKey) Editor.close(Editor.activeKey);
      }
    });

    window.addEventListener('beforeunload', (event) => {
      if (Editor.tabs.some((tab) => Editor.isDirty(tab))) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  },

  async reload() {
    const dirty = Editor.tabs.some((tab) => Editor.isDirty(tab));
    if (dirty && !(await confirmDialog({ title: 'Reload workspace?', message: 'Unsaved changes in open tabs will be lost.', confirmText: 'Reload' }))) return;
    Editor.closeAll();
    WS.full.clear();
    try {
      await WS.load();
      await Editor.restoreTabs();
      toast('Workspace reloaded.');
    } catch (error) {
      toast(error.message, 'error');
    }
  },
};

function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('') || '?';
}

App.start();
