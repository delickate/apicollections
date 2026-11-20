'use strict';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * Tabs and editors: one tab per open request, plus a settings tab per
 * collection (name, description, variables, auth).
 */
const Editor = {
  tabs: [],
  activeKey: null,
  requestHeight: null,

  /* ------------------------------------------------------------ tab management */

  async openRequest(cid, itemId) {
    const key = `r:${cid}:${itemId}`;
    if (!this.tabs.some((tab) => tab.key === key)) {
      const collection = await WS.ensureCollection(cid);
      const found = collection && findItem(collection.items, itemId);
      if (!found) return;
      const draft = clone(found.item);
      this.tabs.push({ key, kind: 'request', cid, itemId, draft, saved: JSON.stringify(draft), sub: 'params', respView: 'body', response: null });
    }
    this.activate(key);
  },

  async openCollectionSettings(cid) {
    const key = `s:${cid}`;
    if (!this.tabs.some((tab) => tab.key === key)) {
      const collection = await WS.ensureCollection(cid);
      if (!collection) return;
      const draft = settingsDraft(collection);
      this.tabs.push({ key, kind: 'collection', cid, draft, saved: JSON.stringify(draft) });
    }
    this.activate(key);
  },

  activate(key) {
    this.activeKey = key;
    const tab = this.active();
    if (tab?.kind === 'request') WS.select(`i:${tab.cid}:${tab.itemId}`);
    this.persistTabs();
    this.render();
  },

  active() {
    return this.tabs.find((tab) => tab.key === this.activeKey) || null;
  },

  isDirty(tab) {
    return JSON.stringify(tab.draft) !== tab.saved;
  },

  async close(key, { force = false } = {}) {
    const index = this.tabs.findIndex((tab) => tab.key === key);
    if (index < 0) return;
    const tab = this.tabs[index];
    if (!force && this.isDirty(tab)) {
      const ok = await confirmDialog({
        title: 'Discard unsaved changes?',
        message: `“${this.tabTitle(tab)}” has changes that are not saved.`,
        confirmText: 'Discard',
      });
      if (!ok) return;
    }
    if (tab.sending) window.desktop.http.cancel(tab.sendId);
    this.tabs.splice(index, 1);
    if (this.activeKey === key) this.activeKey = this.tabs[Math.min(index, this.tabs.length - 1)]?.key || null;
    this.persistTabs();
    this.render();
  },

  closeAll() {
    this.tabs = [];
    this.activeKey = null;
    this.render();
  },

  persistTabs() {
    try {
      localStorage.setItem('open-tabs', JSON.stringify({
        active: this.activeKey,
        tabs: this.tabs.map(({ kind, cid, itemId }) => ({ kind, cid, itemId })),
      }));
    } catch {
      /* not critical */
    }
  },

  async restoreTabs() {
    let stored;
    try {
      stored = JSON.parse(localStorage.getItem('open-tabs') || 'null');
    } catch {
      stored = null;
    }
    if (!stored?.tabs) {
      this.render();
      return;
    }
    for (const tab of stored.tabs) {
      if (!WS.collections.has(tab.cid)) continue;
      if (tab.kind === 'request') await this.openRequest(tab.cid, tab.itemId);
      else await this.openCollectionSettings(tab.cid);
    }
    if (this.tabs.some((tab) => tab.key === stored.active)) this.activate(stored.active);
    else this.render();
  },

  /* ------------------------------------------------------------ notifications from the tree */

  onCollectionDeleted(cid) {
    this.tabs.filter((tab) => tab.cid === cid).forEach((tab) => this.close(tab.key, { force: true }));
  },

  onRequestDeleted(cid, itemId) {
    const tab = this.tabs.find((t) => t.key === `r:${cid}:${itemId}`);
    if (tab) this.close(tab.key, { force: true });
  },

  onRequestRenamed(cid, itemId, name) {
    const tab = this.tabs.find((t) => t.key === `r:${cid}:${itemId}`);
    if (!tab) return;
    const saved = JSON.parse(tab.saved);
    saved.name = name;
    tab.saved = JSON.stringify(saved);
    tab.draft.name = name;
    this.render();
  },

  onRequestMoved(oldCid, itemId, newCid) {
    const tab = this.tabs.find((t) => t.key === `r:${oldCid}:${itemId}`);
    if (!tab) return;
    tab.cid = newCid;
    const wasActive = this.activeKey === tab.key;
    tab.key = `r:${newCid}:${itemId}`;
    if (wasActive) this.activeKey = tab.key;
    this.persistTabs();
    this.render();
  },

  onCollectionChanged(cid) {
    const collection = WS.full.get(cid);
    for (const tab of this.tabs.filter((t) => t.cid === cid)) {
      if (tab.kind === 'collection' && collection && !this.isDirty(tab)) {
        tab.draft = settingsDraft(collection);
        tab.saved = JSON.stringify(tab.draft);
      }
      if (tab.kind === 'request' && collection && !findItem(collection.items, tab.itemId)) {
        this.close(tab.key, { force: true });
      }
    }
    this.render();
  },

  /* ------------------------------------------------------------ rendering */

  tabTitle(tab) {
    if (tab.kind === 'collection') return WS.collections.get(tab.cid)?.name || 'Collection';
    return tab.draft.name || 'Untitled request';
  },

  renderTabStrip() {
    const strip = document.getElementById('tabs');
    strip.replaceChildren(...this.tabs.map((tab) => h('div', {
      class: `tab ${tab.key === this.activeKey ? 'active' : ''} ${this.isDirty(tab) ? 'dirty' : ''}`,
      title: this.tabTitle(tab),
      onclick: () => this.activate(tab.key),
      onauxclick: (event) => {
        if (event.button === 1) this.close(tab.key);
      },
    },
      tab.kind === 'request'
        ? h('span', { class: `method m-${tab.draft.method}` }, tab.draft.method)
        : h('span', { class: 'node-icon collection' }, icon('settings')),
      h('span', { class: 'tab-name' }, this.tabTitle(tab)),
      h('button', {
        class: 'tab-close',
        title: 'Close (Ctrl+W)',
        onclick: (event) => {
          event.stopPropagation();
          this.close(tab.key);
        },
      }, icon('close')))));
    strip.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  },

  refreshDirty() {
    const index = this.tabs.findIndex((tab) => tab.key === this.activeKey);
    const el = document.querySelectorAll('#tabs .tab')[index];
    if (el) {
      const tab = this.tabs[index];
      el.classList.toggle('dirty', this.isDirty(tab));
      el.querySelector('.tab-name').textContent = this.tabTitle(tab);
      const method = el.querySelector('.method');
      if (method && tab.kind === 'request') {
        method.className = `method m-${tab.draft.method}`;
        method.textContent = tab.draft.method;
      }
    }
  },

  render() {
    this.renderTabStrip();
    const body = document.getElementById('tab-body');
    const tab = this.active();
    if (!tab) body.replaceChildren(welcome());
    else if (tab.kind === 'request') body.replaceChildren(this.requestView(tab));
    else body.replaceChildren(this.settingsView(tab));
  },

  /* ------------------------------------------------------------ request view */

  requestView(tab) {
    const draft = tab.draft;
    const collection = WS.collections.get(tab.cid);
    const full = WS.full.get(tab.cid);
    const parents = (full && findItem(full.items, tab.itemId)?.parents) || [];
    const changed = () => this.refreshDirty();

    const crumbs = h('div', { class: 'crumbs' },
      [...WS.folderPath(collection?.folder_id ?? null), collection?.name || '', ...parents.map((p) => p.name)]
        .filter(Boolean)
        .flatMap((name) => [h('span', {}, name), h('span', { class: 'crumb-sep' }, '/')]),
      h('input', {
        type: 'text',
        class: 'title-input',
        value: draft.name,
        maxlength: '255',
        title: 'Request name',
        oninput: (event) => {
          draft.name = event.target.value;
          changed();
        },
      }));

    const methodSelect = h('select', {
      class: `method-select m-${draft.method}`,
      onchange: (event) => {
        draft.method = event.target.value;
        methodSelect.className = `method-select m-${draft.method}`;
        changed();
      },
    }, METHODS.map((method) => h('option', { value: method, selected: method === draft.method }, method)));

    const urlInput = h('input', {
      type: 'text',
      class: 'url-input',
      value: draft.url,
      placeholder: 'https://api.example.com/v1/users  —  use {{variable}} for collection variables',
      spellcheck: false,
      oninput: (event) => {
        draft.url = event.target.value;
        changed();
        if (tab.sub === 'params') renderSub();
      },
      onkeydown: (event) => {
        if (event.key === 'Enter') this.send(tab);
      },
    });

    const sendButton = tab.sending
      ? h('button', { class: 'btn send-btn', onclick: () => window.desktop.http.cancel(tab.sendId) }, 'Cancel')
      : h('button', { class: 'btn btn-primary send-btn', title: 'Send (Ctrl+Enter)', onclick: () => this.send(tab) }, icon('send'), 'Send');

    const urlbar = h('div', { class: 'urlbar' },
      h('div', { class: 'urlbar-group' }, methodSelect, urlInput),
      sendButton,
      h('button', { class: 'btn', title: 'Save (Ctrl+S)', onclick: () => this.save(tab) }, 'Save'),
      h('button', { class: 'btn', title: 'Code snippet', onclick: () => this.showCode(tab) }, icon('code'), 'Code'));

    // ---- request sub-tabs
    const subPane = h('div', { class: 'pane' });
    const subTabs = h('div', { class: 'subtabs' });
    const renderSubTabs = () => {
      const headerCount = draft.headers.filter((x) => x.enabled && x.key).length;
      const paramCount = parseQuery(draft.url).length;
      const defs = [
        ['params', 'Params', paramCount],
        ['headers', 'Headers', headerCount],
        ['body', 'Body', draft.body.mode !== 'none' ? '•' : 0],
        ['auth', 'Auth', 0],
      ];
      subTabs.replaceChildren(...defs.map(([id, label, badge]) => h('button', {
        class: `subtab ${tab.sub === id ? 'active' : ''}`,
        onclick: () => {
          tab.sub = id;
          renderSubTabs();
          renderSub();
        },
      }, label, badge ? h('span', { class: 'badge' }, badge) : null)));
    };
    const renderSub = () => {
      subPane.classList.remove('fill');
      if (tab.sub === 'params') {
        subPane.replaceChildren(
          kvEditor(parseQuery(draft.url).map(([key, value]) => ({ key, value })), (rows) => {
            draft.url = withQuery(draft.url, rows.map((row) => [row.key, row.value]));
            urlInput.value = draft.url;
            changed();
            renderSubTabs();
          }, { keyPlaceholder: 'Query parameter', toggle: false }),
          h('p', { class: 'hint' }, 'Parameters stay in sync with the URL.'));
      } else if (tab.sub === 'headers') {
        subPane.replaceChildren(kvEditor(draft.headers, (rows) => {
          draft.headers = rows;
          changed();
          renderSubTabs();
        }, { keyPlaceholder: 'Header' }), h('p', { class: 'hint' }, 'Content-Type is added automatically for JSON, text and form bodies unless you set one.'));
      } else if (tab.sub === 'body') {
        this.bodyEditor(subPane, draft.body, () => {
          changed();
          renderSubTabs();
        });
      } else {
        subPane.replaceChildren(authEditor(draft.auth, true, changed, WS.full.get(tab.cid)?.auth));
      }
    };
    renderSubTabs();
    renderSub();

    const requestSection = h('div', { class: 'section' }, subTabs, subPane);

    // ---- response
    const responseSection = h('div', { class: 'section response' });
    tab.renderResponse = () => responseSection.replaceChildren(...this.responseView(tab));
    tab.renderResponse();

    const handle = h('div', { class: 'split-handle' });
    const editor = h('div', { class: 'editor' }, crumbs, urlbar, requestSection, handle, responseSection);
    if (this.requestHeight) editor.style.setProperty('--req-h', `${this.requestHeight}px`);
    makeRowResizer(handle, editor, (height) => {
      this.requestHeight = height;
    });
    tab.urlInput = urlInput;
    return editor;
  },

  bodyEditor(pane, body, changed) {
    const modes = [['none', 'None'], ['json', 'JSON'], ['raw', 'Text'], ['urlencoded', 'x-www-form-urlencoded'], ['formdata', 'form-data']];
    const content = h('div');
    const group = `body-mode-${uid()}`;
    const radios = h('div', { class: 'radio-row' }, modes.map(([mode, label]) => h('label', {},
      h('input', {
        type: 'radio',
        name: group,
        checked: body.mode === mode,
        onchange: () => {
          body.mode = mode;
          changed();
          renderContent();
        },
      }), label)));

    const renderContent = () => {
      pane.classList.toggle('fill', body.mode === 'json' || body.mode === 'raw');
      if (body.mode === 'json' || body.mode === 'raw') {
        const area = h('textarea', {
          class: 'code-area',
          spellcheck: false,
          placeholder: body.mode === 'json' ? '{\n  "name": "value"\n}' : 'Request body',
          oninput: (event) => {
            body.raw = event.target.value;
            changed();
          },
          onkeydown: (event) => {
            if (event.key === 'Tab') {
              event.preventDefault();
              area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
              body.raw = area.value;
              changed();
            }
          },
        });
        area.value = body.raw || '';
        const tools = body.mode === 'json'
          ? h('div', { class: 'subtabs-right' }, h('button', {
            class: 'link-btn',
            onclick: () => {
              try {
                area.value = JSON.stringify(JSON.parse(area.value), null, 2);
                body.raw = area.value;
                changed();
              } catch (error) {
                toast(`Invalid JSON: ${error.message}`, 'error');
              }
            },
          }, 'Beautify'))
          : null;
        content.replaceChildren(area);
        pane.replaceChildren(h('div', { class: 'radio-row' }, radios, tools), content);
        content.style.minHeight = '0';
        content.style.display = 'grid';
        return;
      }
      content.removeAttribute('style');
      if (body.mode === 'urlencoded' || body.mode === 'formdata') {
        const isForm = body.mode === 'formdata';
        content.replaceChildren(h('div', { style: { height: '10px' } }), kvEditor(body[body.mode] || [], (rows) => {
          body[body.mode] = rows;
          changed();
        }, { keyPlaceholder: 'Field', files: isForm ? () => window.desktop.files.pickUpload() : null }),
        isForm ? h('p', { class: 'hint' }, 'Sent as multipart/form-data. Switch a field to File to attach a file from this computer.') : null);
      } else {
        content.replaceChildren(h('p', { class: 'hint' }, 'This request does not send a body.'));
      }
      pane.replaceChildren(radios, content);
    };
    renderContent();
  },

  responseView(tab) {
    const response = tab.response;
    const tabs = h('div', { class: 'subtabs' });
    const pane = h('div', { class: 'pane' });

    if (tab.sending) {
      tabs.append(h('button', { class: 'subtab active' }, 'Response'));
      pane.append(h('div', { class: 'sending-overlay' }, h('div', { class: 'spinner' }), 'Sending request…',
        h('button', { class: 'btn', onclick: () => window.desktop.http.cancel(tab.sendId) }, 'Cancel')));
      return [tabs, pane];
    }
    if (!response) {
      tabs.append(h('button', { class: 'subtab active' }, 'Response'));
      pane.append(h('div', { class: 'resp-empty' }, h('div', {}, icon('send'), h('div', {}, 'Enter a URL and click Send to get a response.'))));
      return [tabs, pane];
    }
    if (!response.ok) {
      tabs.append(h('button', { class: 'subtab active' }, 'Response'),
        h('div', { class: 'subtabs-right resp-meta' }, h('span', { class: 'status-pill s-0' }, response.cancelled ? 'Cancelled' : 'Error'), h('span', {}, `${response.timeMs} ms`)));
      pane.append(h('div', { class: 'resp-empty' }, h('div', {},
        h('div', { class: 'resp-error' }, response.cancelled ? 'Request cancelled.' : 'Could not send request'),
        h('div', {}, response.cancelled ? '' : response.error))));
      return [tabs, pane];
    }

    const statusClass = `s-${String(response.status)[0]}`;
    const meta = h('div', { class: 'subtabs-right resp-meta' },
      h('span', { class: `status-pill ${statusClass}` }, `${response.status} ${response.statusText || ''}`.trim()),
      h('span', {}, 'Time ', h('b', {}, `${response.timeMs} ms`)),
      h('span', {}, 'Size ', h('b', {}, formatBytes(response.size) + (response.truncated ? ' (truncated)' : ''))),
      response.body !== null ? h('button', {
        class: 'icon-btn',
        title: 'Copy response body',
        onclick: () => navigator.clipboard.writeText(response.body).then(() => toast('Response copied.')),
      }, icon('copy')) : null);

    const views = [['body', 'Body'], ['raw', 'Raw'], ['headers', `Headers (${response.headers.length})`]];
    for (const [id, label] of views) {
      tabs.append(h('button', {
        class: `subtab ${tab.respView === id ? 'active' : ''}`,
        onclick: () => {
          tab.respView = id;
          tab.renderResponse();
        },
      }, label));
    }
    tabs.append(meta);

    if (tab.respView === 'headers') {
      pane.append(h('table', { class: 'headers-table' }, response.headers.map(([key, value]) => h('tr', {}, h('td', {}, key), h('td', {}, value)))));
    } else if (response.body === null) {
      if (/^image\//i.test(response.contentType) && response.bodyBase64) {
        pane.append(h('img', { src: `data:${response.contentType.split(';')[0]};base64,${response.bodyBase64}`, style: { maxWidth: '100%' }, alt: 'Image response' }));
      } else {
        pane.append(h('div', { class: 'resp-empty' }, `Binary response (${response.contentType || 'unknown type'}, ${formatBytes(response.size)}).`));
      }
    } else if (tab.respView === 'body') {
      const pre = h('pre', { class: 'code-view' });
      const parsed = tryParseJson(response.body);
      if (parsed !== undefined && response.body.length < 3_000_000) pre.innerHTML = highlightJson(JSON.stringify(parsed, null, 2));
      else pre.textContent = response.body || '(empty body)';
      pane.append(pre);
    } else {
      pane.append(h('pre', { class: 'code-view' }, response.body || '(empty body)'));
    }
    return [tabs, pane];
  },

  /* ------------------------------------------------------------ actions */

  async save(tab = this.active()) {
    if (!tab) return;
    try {
      if (tab.kind === 'request') {
        tab.draft.name = tab.draft.name.trim() || 'Untitled request';
        await WS.saveRequest(tab.cid, tab.itemId, tab.draft);
        const stored = findItem(WS.full.get(tab.cid).items, tab.itemId)?.item;
        if (stored) tab.draft = clone(stored);
        tab.saved = JSON.stringify(tab.draft);
      } else {
        if (!tab.draft.name.trim()) {
          toast('The collection needs a name.', 'error');
          return;
        }
        const collection = await WS.patchCollection(tab.cid, tab.draft);
        tab.draft = settingsDraft(collection);
        tab.saved = JSON.stringify(tab.draft);
      }
      toast('Saved.');
      this.render();
    } catch (error) {
      if (!(error instanceof ApiError)) toast(error.message, 'error');
    }
  },

  showCode(tab = this.active()) {
    if (!tab || tab.kind !== 'request') return;
    let prepared;
    try {
      prepared = prepareRequest(tab.draft, WS.full.get(tab.cid));
    } catch (error) {
      toast(error.message, 'error');
      return;
    }
    const bodyMode = tab.draft.body.mode;
    let lang = 'curl';
    try {
      lang = localStorage.getItem('codeLanguage') || 'curl';
    } catch {
      /* storage unavailable */
    }
    if (!CODE_LANGUAGES.some((x) => x.id === lang)) lang = 'curl';

    openModal((close) => {
      const pre = h('pre', { class: 'code-view snippet-code' });
      const list = h('div', { class: 'snippet-langs', role: 'listbox' });
      const show = () => {
        try {
          pre.textContent = codeSnippet(lang, prepared, bodyMode);
        } catch (error) {
          pre.textContent = `Could not generate this snippet: ${error.message}`;
        }
        list.replaceChildren(...CODE_LANGUAGES.map((x) => h('button', {
          type: 'button',
          role: 'option',
          class: `snippet-lang ${x.id === lang ? 'active' : ''}`,
          'aria-selected': String(x.id === lang),
          onclick: () => {
            lang = x.id;
            try {
              localStorage.setItem('codeLanguage', lang);
            } catch {
              /* storage unavailable */
            }
            show();
          },
        }, x.label)));
      };
      show();
      const copy = h('button', {
        type: 'button',
        class: 'btn btn-primary',
        autofocus: true,
        onclick: () => navigator.clipboard.writeText(pre.textContent).then(() => toast('Code copied.'), () => toast('Could not copy.', 'error')),
      }, icon('copy'), 'Copy');
      return h('div', { class: 'modal snippet-modal' },
        h('div', { class: 'snippet-head' },
          h('h3', {}, 'Code snippet'),
          h('span', { class: 'hint' }, 'Variables and auth are filled in.'),
          h('button', { type: 'button', class: 'icon-btn', title: 'Close', onclick: () => close(null) }, icon('close'))),
        h('div', { class: 'snippet-body' }, list, pre),
        h('div', { class: 'modal-actions' }, copy));
    });
  },

  async send(tab = this.active()) {
    if (!tab || tab.kind !== 'request' || tab.sending) return;
    const collection = WS.full.get(tab.cid);
    let prepared;
    try {
      prepared = prepareRequest(tab.draft, collection);
    } catch (error) {
      toast(error.message, 'error');
      return;
    }

    tab.sending = true;
    tab.sendId = uid();
    if (this.active() === tab) this.render();
    const response = await window.desktop.http.send({ id: tab.sendId, ...prepared });
    tab.sending = false;
    tab.response = response;
    if (response.ok && tab.respView === 'headers') tab.respView = 'body';
    if (this.active() === tab) this.render();
  },

  /* ------------------------------------------------------------ collection settings */

  settingsView(tab) {
    const draft = tab.draft;
    const full = WS.full.get(tab.cid);
    const counts = countItems(full?.items || []);
    const changed = () => this.refreshDirty();

    const nameInput = h('input', {
      type: 'text', value: draft.name, maxlength: '160',
      oninput: (event) => {
        draft.name = event.target.value;
        changed();
      },
    });
    const description = h('textarea', {
      rows: 4,
      placeholder: 'What this collection is for…',
      oninput: (event) => {
        draft.description = event.target.value;
        changed();
      },
    });
    description.value = draft.description;

    return h('div', { class: 'settings-page' },
      h('h2', {}, h('span', { class: 'node-icon collection' }, icon('collection')), WS.collections.get(tab.cid)?.name || 'Collection'),
      h('div', { class: 'pill-row' },
        h('span', { class: 'pill' }, `${counts.requests} request${counts.requests === 1 ? '' : 's'}`),
        h('span', { class: 'pill' }, `${counts.folders} folder${counts.folders === 1 ? '' : 's'}`),
        h('span', { class: 'pill' }, `Location: ${['Workspace', ...WS.folderPath(WS.collections.get(tab.cid)?.folder_id ?? null)].join(' / ')}`)),
      h('h3', {}, 'Details'),
      h('div', { class: 'stack' }, h('label', {}, 'Name', nameInput), h('label', {}, 'Description', description)),
      h('h3', {}, 'Variables'),
      h('p', { class: 'hint' }, 'Use {{name}} in URLs, headers, bodies and auth fields of this collection\'s requests.'),
      h('div', { class: 'stack' }, kvEditor(draft.variables, (rows) => {
        draft.variables = rows;
        changed();
      }, { keyPlaceholder: 'Variable', valuePlaceholder: 'Value' })),
      h('h3', {}, 'Authorization'),
      h('p', { class: 'hint' }, 'Requests set to “Inherit from collection” use this.'),
      authEditor(draft.auth, false, changed),
      h('div', { class: 'settings-actions' },
        h('button', { class: 'btn btn-primary', onclick: () => this.save(tab) }, 'Save changes'),
        h('button', { class: 'btn', onclick: () => WS.exportCollection(tab.cid, 'native') }, icon('upload'), 'Export JSON'),
        h('button', { class: 'btn', onclick: () => WS.exportCollection(tab.cid, 'postman') }, icon('upload'), 'Export Postman v2.1')));
  },
};

/* ---------------- request preparation ---------------- */

function variablesOf(collection) {
  const map = new Map();
  for (const variable of collection?.variables || []) {
    if (variable.enabled && variable.key) map.set(variable.key, variable.value);
  }
  return map;
}

function substitute(text, variables) {
  let result = String(text ?? '');
  // A few passes so variables may refer to other variables.
  for (let pass = 0; pass < 5 && /{{\s*[^{}]+?\s*}}/.test(result); pass++) {
    const next = result.replace(/{{\s*([^{}]+?)\s*}}/g, (match, name) => (variables.has(name) ? variables.get(name) : match));
    if (next === result) break;
    result = next;
  }
  return result;
}

function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function prepareRequest(draft, collection) {
  const variables = variablesOf(collection);
  const sub = (text) => substitute(text, variables);

  let url = sub(draft.url).trim();
  if (!url) throw new Error('Enter a URL to send the request to.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  const unresolved = url.match(/{{\s*([^{}]+?)\s*}}/);
  if (unresolved) throw new Error(`The variable {{${unresolved[1]}}} is not defined in this collection.`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('The URL is not valid.');
  }

  const headers = {};
  const setHeader = (key, value) => {
    const existing = Object.keys(headers).find((name) => name.toLowerCase() === key.toLowerCase());
    if (existing) headers[existing] = `${headers[existing]}, ${value}`;
    else headers[key] = value;
  };
  const hasHeader = (key) => Object.keys(headers).some((name) => name.toLowerCase() === key.toLowerCase());

  for (const header of draft.headers) {
    if (header.enabled && header.key.trim()) setHeader(sub(header.key).trim(), sub(header.value));
  }

  const auth = draft.auth.type === 'inherit' ? (collection?.auth || { type: 'none' }) : draft.auth;
  if (auth.type === 'bearer' && auth.bearer.token && !hasHeader('Authorization')) {
    setHeader('Authorization', `Bearer ${sub(auth.bearer.token)}`);
  } else if (auth.type === 'basic' && !hasHeader('Authorization')) {
    setHeader('Authorization', `Basic ${base64Utf8(`${sub(auth.basic.username)}:${sub(auth.basic.password)}`)}`);
  } else if (auth.type === 'apikey' && auth.apikey.key) {
    if (auth.apikey.in === 'query') parsed.searchParams.append(sub(auth.apikey.key), sub(auth.apikey.value));
    else setHeader(sub(auth.apikey.key), sub(auth.apikey.value));
  }

  let body;
  const mode = draft.body.mode;
  if (mode === 'json' || mode === 'raw') {
    body = sub(draft.body.raw);
    if (!hasHeader('Content-Type')) setHeader('Content-Type', mode === 'json' ? 'application/json' : 'text/plain');
  } else if (mode === 'urlencoded') {
    body = new URLSearchParams(draft.body.urlencoded.filter((x) => x.enabled && x.key).map((x) => [sub(x.key), sub(x.value)])).toString();
    if (!hasHeader('Content-Type')) setHeader('Content-Type', 'application/x-www-form-urlencoded');
  } else if (mode === 'formdata') {
    body = {
      formdata: draft.body.formdata.filter((x) => x.enabled && x.key).map((x) => (x.type === 'file'
        ? { key: sub(x.key), file: x.src || '' }
        : { key: sub(x.key), value: sub(x.value) })),
    };
  }

  return { method: draft.method, url: parsed.toString(), headers, body };
}

/* ---------------- small helpers ---------------- */

function settingsDraft(collection) {
  return {
    name: collection.name,
    description: collection.description || '',
    variables: clone(collection.variables || []),
    auth: clone(collection.auth || { type: 'none', bearer: { token: '' }, basic: { username: '', password: '' }, apikey: { key: '', value: '', in: 'header' } }),
  };
}

function countItems(items) {
  let requests = 0;
  let folders = 0;
  for (const item of items) {
    if (item.type === 'folder') {
      folders++;
      const inner = countItems(item.items);
      requests += inner.requests;
      folders += inner.folders;
    } else {
      requests++;
    }
  }
  return { requests, folders };
}

function tryParseJson(text) {
  const trimmed = (text || '').trim();
  if (!trimmed || !'{["'.includes(trimmed[0]) && !/^-?\d/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Query pairs from a URL string, left un-decoded so {{vars}} survive. */
function parseQuery(url) {
  const withoutHash = url.split('#')[0];
  const start = withoutHash.indexOf('?');
  if (start < 0) return [];
  return withoutHash.slice(start + 1).split('&').filter((part) => part !== '').map((part) => {
    const eq = part.indexOf('=');
    return eq < 0 ? [part, ''] : [part.slice(0, eq), part.slice(eq + 1)];
  });
}

function withQuery(url, pairs) {
  const hashIndex = url.indexOf('#');
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const beforeHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const base = beforeHash.split('?')[0];
  const query = pairs.filter(([key, value]) => key !== '' || value !== '').map(([key, value]) => (value === '' ? key : `${key}=${value}`)).join('&');
  return base + (query ? `?${query}` : '') + hash;
}

function authEditor(auth, allowInherit, changed, inheritedAuth) {
  const fields = h('div', { class: 'auth-fields' });
  const types = [
    ...(allowInherit ? [['inherit', 'Inherit from collection']] : []),
    ['none', 'No auth'],
    ['bearer', 'Bearer token'],
    ['basic', 'Basic auth'],
    ['apikey', 'API key'],
  ];

  const input = (label, object, field, type = 'text', placeholder = '') => {
    const el = h('input', {
      type,
      value: object[field] || '',
      placeholder,
      spellcheck: false,
      oninput: (event) => {
        object[field] = event.target.value;
        changed();
      },
    });
    return h('label', {}, label, el);
  };

  const renderFields = () => {
    if (auth.type === 'bearer') fields.replaceChildren(input('Token', auth.bearer, 'token', 'text', '{{token}}'));
    else if (auth.type === 'basic') fields.replaceChildren(input('Username', auth.basic, 'username'), input('Password', auth.basic, 'password', 'password'));
    else if (auth.type === 'apikey') {
      fields.replaceChildren(
        input('Key', auth.apikey, 'key', 'text', 'X-API-Key'),
        input('Value', auth.apikey, 'value'),
        h('label', {}, 'Add to', h('select', {
          onchange: (event) => {
            auth.apikey.in = event.target.value;
            changed();
          },
        }, h('option', { value: 'header', selected: auth.apikey.in !== 'query' }, 'Header'),
          h('option', { value: 'query', selected: auth.apikey.in === 'query' }, 'Query params'))));
    } else if (auth.type === 'inherit') {
      const label = { none: 'no auth', bearer: 'a bearer token', basic: 'basic auth', apikey: 'an API key' }[inheritedAuth?.type || 'none'];
      fields.replaceChildren(h('p', { class: 'hint' }, `This request uses the collection's authorization (currently ${label}). Change it in the collection's settings.`));
    } else {
      fields.replaceChildren(h('p', { class: 'hint' }, 'No authorization is sent with this request.'));
    }
  };

  const select = h('select', {
    onchange: (event) => {
      auth.type = event.target.value;
      changed();
      renderFields();
    },
  }, types.map(([value, label]) => h('option', { value, selected: auth.type === value }, label)));

  renderFields();
  return h('div', { class: 'auth-grid' }, h('label', {}, 'Type', select), fields);
}

function makeRowResizer(handle, container, onResize) {
  handle.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const top = container.querySelector('.section').getBoundingClientRect().top;
    const max = container.getBoundingClientRect().bottom - 120;
    handle.classList.add('dragging');
    const move = (e) => {
      const height = Math.max(120, Math.min(max - top, e.clientY - top));
      container.style.setProperty('--req-h', `${height}px`);
      onResize(height);
    };
    const up = () => {
      handle.classList.remove('dragging');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

function welcome() {
  return h('div', { class: 'welcome' }, h('div', {},
    h('img', { src: '../../assets/logo.svg', alt: '' }),
    h('h2', {}, 'Ready when you are'),
    h('p', {}, 'Pick a request from the sidebar, or create a collection to start. Organise collections in folders nested as deep as you need.'),
    h('div', { class: 'welcome-actions' },
      h('button', { class: 'btn btn-primary', onclick: () => WS.newCollection(null) }, icon('collectionPlus'), 'New collection'),
      h('button', { class: 'btn', onclick: () => WS.newFolder(null) }, icon('folderPlus'), 'New folder'),
      h('button', { class: 'btn', onclick: () => WS.importFiles(null) }, icon('download'), 'Import JSON / Postman')),
    h('div', { class: 'shortcuts' },
      h('div', {}, h('kbd', {}, 'Ctrl'), ' + ', h('kbd', {}, 'Enter'), '  send request'),
      h('div', {}, h('kbd', {}, 'Ctrl'), ' + ', h('kbd', {}, 'S'), '  save'),
      h('div', {}, h('kbd', {}, 'Ctrl'), ' + ', h('kbd', {}, 'W'), '  close tab'))));
}
