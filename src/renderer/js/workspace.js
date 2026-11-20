'use strict';

/**
 * Workspace tree: nested folders → collections → request folders → requests.
 * Folders and collection summaries come from GET /workspace; a collection's
 * requests are loaded the first time it is opened.
 */
const WS = {
  folders: new Map(),
  collections: new Map(),
  full: new Map(),
  loading: new Set(),
  expanded: new Set(),
  selected: null,
  filter: '',
  dragging: null,

  /* ------------------------------------------------------------ data */

  async load() {
    const data = await api('GET', '/workspace');
    this.folders = new Map(data.folders.map((folder) => [folder.id, folder]));
    this.collections = new Map(data.collections.map((collection) => [collection.id, collection]));
    for (const id of [...this.full.keys()]) {
      if (!this.collections.has(id)) this.full.delete(id);
    }
    try {
      this.expanded = new Set(JSON.parse(localStorage.getItem('tree-expanded') || '[]'));
    } catch {
      this.expanded = new Set();
    }
    // Re-open collections that were expanded last time.
    for (const key of this.expanded) {
      if (key.startsWith('c:')) this.ensureCollection(Number(key.slice(2)));
    }
    this.render();
  },

  reset() {
    this.folders.clear();
    this.collections.clear();
    this.full.clear();
    this.selected = null;
    document.getElementById('tree').replaceChildren();
  },

  persistExpanded() {
    try {
      localStorage.setItem('tree-expanded', JSON.stringify([...this.expanded]));
    } catch {
      /* not critical */
    }
  },

  async ensureCollection(cid) {
    if (this.full.has(cid)) return this.full.get(cid);
    if (this.loading.has(cid)) {
      await new Promise((resolve) => {
        const check = () => (this.loading.has(cid) ? setTimeout(check, 50) : resolve());
        check();
      });
      return this.full.get(cid);
    }
    this.loading.add(cid);
    this.render();
    try {
      const { collection } = await api('GET', `/collections/${cid}`);
      this.full.set(cid, collection);
      return collection;
    } catch (error) {
      toast(error.message, 'error');
      this.expanded.delete(`c:${cid}`);
      return null;
    } finally {
      this.loading.delete(cid);
      this.render();
    }
  },

  /** Saves part of a collection; on failure reloads it so the tree matches the server. */
  async patchCollection(cid, patch) {
    setSyncState('Saving…');
    try {
      const { collection } = await api('PATCH', `/collections/${cid}`, patch);
      this.full.set(cid, collection);
      this.collections.set(cid, { ...this.collections.get(cid), ...summary(collection) });
      setSyncState('All changes saved');
      return collection;
    } catch (error) {
      setSyncState('');
      toast(`Could not save: ${error.message}`, 'error');
      this.full.delete(cid);
      await this.ensureCollection(cid);
      Editor.onCollectionChanged(cid);
      throw error;
    } finally {
      this.render();
    }
  },

  saveItems(cid) {
    return this.patchCollection(cid, { items: this.full.get(cid).items });
  },

  /** Replace a request's stored fields with the editor draft and save. */
  async saveRequest(cid, itemId, draft) {
    const collection = await this.ensureCollection(cid);
    const found = collection && findItem(collection.items, itemId);
    if (!found) throw new Error('This request no longer exists.');
    Object.assign(found.item, clone(draft), { id: itemId, type: 'request' });
    await this.saveItems(cid);
  },

  /* ------------------------------------------------------------ tree helpers */

  childFolders(parentId) {
    return [...this.folders.values()]
      .filter((folder) => (folder.parent_id ?? null) === parentId)
      .sort(bySortThenName);
  },

  childCollections(folderId) {
    return [...this.collections.values()]
      .filter((collection) => (collection.folder_id ?? null) === folderId)
      .sort(bySortThenName);
  },

  isFolderInside(folderId, ancestorId) {
    let current = folderId;
    let guard = 0;
    while (current !== null && current !== undefined && guard++ < 200) {
      if (current === ancestorId) return true;
      current = this.folders.get(current)?.parent_id ?? null;
    }
    return false;
  },

  folderPath(folderId) {
    const names = [];
    let current = folderId;
    let guard = 0;
    while (current !== null && current !== undefined && guard++ < 200) {
      const folder = this.folders.get(current);
      if (!folder) break;
      names.unshift(folder.name);
      current = folder.parent_id ?? null;
    }
    return names;
  },

  /* ------------------------------------------------------------ rendering */

  render() {
    const tree = document.getElementById('tree');
    const scroll = tree.scrollTop;
    const filter = this.filter.trim().toLowerCase();
    const rows = [];

    const matches = (text) => !filter || String(text).toLowerCase().includes(filter);

    const itemMatches = (item) => matches(item.name)
      || (item.type === 'request' && matches(item.url))
      || (item.type === 'folder' && item.items.some(itemMatches));

    const collectionMatches = (collection) => {
      if (matches(collection.name)) return true;
      const full = this.full.get(collection.id);
      return !!full && full.items.some(itemMatches);
    };

    const folderMatches = (folder) => matches(folder.name)
      || this.childFolders(folder.id).some(folderMatches)
      || this.childCollections(folder.id).some(collectionMatches);

    const renderItems = (cid, items, depth) => {
      for (const item of items) {
        if (filter && !itemMatches(item)) continue;
        const key = `i:${cid}:${item.id}`;
        if (item.type === 'folder') {
          const open = this.expanded.has(key) || !!filter;
          rows.push(this.row({
            key, depth, open, kind: 'reqfolder', cid, item,
            name: item.name,
            iconName: open ? 'folderOpen' : 'folder',
            hasChildren: item.items.length > 0,
          }));
          if (open) renderItems(cid, item.items, depth + 1);
        } else {
          rows.push(this.row({ key, depth, kind: 'request', cid, item, name: item.name }));
        }
      }
    };

    const renderCollection = (collection, depth) => {
      if (filter && !collectionMatches(collection)) return;
      const key = `c:${collection.id}`;
      const full = this.full.get(collection.id);
      const open = this.expanded.has(key) || (!!filter && !!full && full.items.some(itemMatches));
      rows.push(this.row({
        key, depth, open, kind: 'collection', cid: collection.id,
        name: collection.name, iconName: 'collection', hasChildren: true,
      }));
      if (!open) return;
      if (this.loading.has(collection.id) && !full) {
        rows.push(h('div', { class: 'tree-loading', style: { paddingLeft: `${30 + (depth + 1) * 14}px` } }, 'Loading…'));
      } else if (full) {
        if (full.items.length === 0 && !filter) {
          rows.push(h('div', { class: 'tree-loading', style: { paddingLeft: `${30 + (depth + 1) * 14}px` } },
            'Empty. ', h('button', { class: 'link-btn', onclick: () => this.addRequest(collection.id, null) }, 'Add a request')));
        }
        renderItems(collection.id, full.items, depth + 1);
      }
    };

    const renderFolder = (folder, depth) => {
      if (filter && !folderMatches(folder)) return;
      const key = `f:${folder.id}`;
      const open = this.expanded.has(key) || !!filter;
      const childCount = this.childFolders(folder.id).length + this.childCollections(folder.id).length;
      rows.push(this.row({
        key, depth, open, kind: 'folder', fid: folder.id,
        name: folder.name, iconName: open ? 'folderOpen' : 'folder',
        hasChildren: childCount > 0, count: childCount,
      }));
      if (!open) return;
      for (const child of this.childFolders(folder.id)) renderFolder(child, depth + 1);
      for (const collection of this.childCollections(folder.id)) renderCollection(collection, depth + 1);
    };

    for (const folder of this.childFolders(null)) renderFolder(folder, 0);
    for (const collection of this.childCollections(null)) renderCollection(collection, 0);

    if (rows.length === 0) {
      rows.push(filter
        ? h('div', { class: 'tree-empty' }, `Nothing matches “${this.filter}”.`)
        : h('div', { class: 'tree-empty' },
          h('div', {}, 'Your workspace is empty.'),
          h('div', { class: 'welcome-actions' },
            h('button', { class: 'btn btn-primary', onclick: () => this.newCollection(null) }, icon('plus'), 'New collection'),
            h('button', { class: 'btn', onclick: () => this.importFiles(null) }, icon('download'), 'Import'))));
    }

    tree.replaceChildren(...rows);
    tree.scrollTop = scroll;
  },

  row(node) {
    const { key, depth, open, kind, name, iconName, hasChildren, count } = node;
    const isContainer = kind !== 'request';
    const children = [
      h('span', { class: `twisty ${open ? 'open' : ''} ${isContainer && hasChildren !== false ? '' : 'empty'}` }, icon('chevron')),
    ];
    if (kind === 'request') {
      children.push(h('span', { class: `method m-${node.item.method}` }, node.item.method === 'DELETE' ? 'DEL' : node.item.method === 'OPTIONS' ? 'OPT' : node.item.method));
    } else {
      children.push(h('span', { class: `node-icon ${kind}` }, icon(iconName)));
    }
    children.push(h('span', { class: 'node-name', title: kind === 'request' ? `${name}\n${node.item.url}` : name }, name));
    if (kind === 'folder' && count) children.push(h('span', { class: 'node-count' }, count));
    children.push(h('button', {
      class: 'icon-btn node-more',
      title: 'More actions',
      onclick: (event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        this.showMenu(node, rect.left, rect.bottom + 2);
      },
    }, icon('more')));

    const el = h('div', {
      class: `node-row ${this.selected === key ? 'selected' : ''}`,
      style: { paddingLeft: `${4 + depth * 14}px` },
      draggable: 'true',
      dataset: { key },
      onclick: () => this.activate(node),
      ondblclick: (event) => {
        event.stopPropagation();
        if (kind !== 'request') this.rename(node);
      },
      oncontextmenu: (event) => {
        event.preventDefault();
        this.select(key);
        this.showMenu(node, event.clientX, event.clientY);
      },
    }, children);

    this.attachDnD(el, node);
    return el;
  },

  select(key) {
    this.selected = key;
    document.querySelectorAll('#tree .node-row').forEach((row) => row.classList.toggle('selected', row.dataset.key === key));
  },

  toggle(key, force) {
    const open = force ?? !this.expanded.has(key);
    if (open) this.expanded.add(key);
    else this.expanded.delete(key);
    this.persistExpanded();
  },

  async activate(node) {
    this.select(node.key);
    if (node.kind === 'request') {
      Editor.openRequest(node.cid, node.item.id);
      return;
    }
    this.toggle(node.key);
    this.render();
    if (node.kind === 'collection' && this.expanded.has(node.key)) await this.ensureCollection(node.cid);
  },

  /** Expand a node and all of its ancestors so it is visible. */
  reveal(cid, itemId) {
    const collection = this.collections.get(cid);
    if (!collection) return;
    let folderId = collection.folder_id ?? null;
    while (folderId !== null) {
      this.expanded.add(`f:${folderId}`);
      folderId = this.folders.get(folderId)?.parent_id ?? null;
    }
    this.expanded.add(`c:${cid}`);
    const full = this.full.get(cid);
    if (full && itemId) {
      const found = findItem(full.items, itemId);
      for (const parent of found?.parents || []) this.expanded.add(`i:${cid}:${parent.id}`);
    }
    this.persistExpanded();
    this.selected = itemId ? `i:${cid}:${itemId}` : `c:${cid}`;
    this.render();
    setTimeout(() => document.querySelector(`#tree [data-key="${CSS.escape(this.selected)}"]`)?.scrollIntoView({ block: 'nearest' }), 0);
  },

  /* ------------------------------------------------------------ menus */

  showMenu(node, x, y) {
    const items = [];
    if (node.kind === 'folder') {
      items.push(
        { label: 'New sub-folder', icon: 'folderPlus', action: () => this.newFolder(node.fid) },
        { label: 'New collection', icon: 'collectionPlus', action: () => this.newCollection(node.fid) },
        { label: 'Import into this folder…', icon: 'download', action: () => this.importFiles(node.fid) },
        '-',
        { label: 'Export as OpenAPI 3 (YAML)', icon: 'upload', action: () => this.exportYaml(node, 'openapi') },
        { label: 'Export as Kong config (YAML)', icon: 'upload', action: () => this.exportYaml(node, 'kong') },
        { label: 'Export as API document (Word)', icon: 'upload', action: () => this.exportDocx(node) },
        '-',
        { label: 'Rename', icon: 'edit', action: () => this.rename(node) },
        this.folders.get(node.fid)?.parent_id ? { label: 'Move to top level', icon: 'arrowUp', action: () => this.moveFolder(node.fid, null) } : null,
        '-',
        { label: 'Delete folder', icon: 'trash', danger: true, action: () => this.deleteFolder(node.fid) },
      );
    } else if (node.kind === 'collection') {
      items.push(
        { label: 'Add request', icon: 'plus', action: () => this.addRequest(node.cid, null) },
        { label: 'Add folder', icon: 'folderPlus', action: () => this.addItemFolder(node.cid, null) },
        '-',
        { label: 'Variables, auth & details', icon: 'settings', action: () => Editor.openCollectionSettings(node.cid) },
        { label: 'Rename', icon: 'edit', action: () => this.rename(node) },
        { label: 'Duplicate', icon: 'copy', action: () => this.duplicateCollection(node.cid) },
        this.collections.get(node.cid)?.folder_id ? { label: 'Move to top level', icon: 'arrowUp', action: () => this.moveCollection(node.cid, null) } : null,
        '-',
        { label: 'Export (JSON)', icon: 'upload', action: () => this.exportCollection(node.cid, 'native') },
        { label: 'Export as Postman v2.1', icon: 'upload', action: () => this.exportCollection(node.cid, 'postman') },
        { label: 'Export as OpenAPI 3 (YAML)', icon: 'upload', action: () => this.exportYaml(node, 'openapi') },
        { label: 'Export as Kong config (YAML)', icon: 'upload', action: () => this.exportYaml(node, 'kong') },
        { label: 'Export as API document (Word)', icon: 'upload', action: () => this.exportDocx(node) },
        '-',
        { label: 'Delete collection', icon: 'trash', danger: true, action: () => this.deleteCollection(node.cid) },
      );
    } else if (node.kind === 'reqfolder') {
      items.push(
        { label: 'Add request', icon: 'plus', action: () => this.addRequest(node.cid, node.item.id) },
        { label: 'Add folder', icon: 'folderPlus', action: () => this.addItemFolder(node.cid, node.item.id) },
        '-',
        { label: 'Rename', icon: 'edit', action: () => this.rename(node) },
        { label: 'Duplicate', icon: 'copy', action: () => this.duplicateItem(node.cid, node.item.id) },
        '-',
        { label: 'Export as OpenAPI 3 (YAML)', icon: 'upload', action: () => this.exportYaml(node, 'openapi') },
        { label: 'Export as Kong config (YAML)', icon: 'upload', action: () => this.exportYaml(node, 'kong') },
        { label: 'Export as API document (Word)', icon: 'upload', action: () => this.exportDocx(node) },
        '-',
        { label: 'Delete folder', icon: 'trash', danger: true, action: () => this.deleteItem(node.cid, node.item.id) },
      );
    } else {
      items.push(
        { label: 'Open', icon: 'request', action: () => Editor.openRequest(node.cid, node.item.id) },
        { label: 'Rename', icon: 'edit', action: () => this.rename(node) },
        { label: 'Duplicate', icon: 'copy', action: () => this.duplicateItem(node.cid, node.item.id) },
        '-',
        { label: 'Delete request', icon: 'trash', danger: true, action: () => this.deleteItem(node.cid, node.item.id) },
      );
    }
    contextMenu.open(x, y, items);
  },

  /* ------------------------------------------------------------ folder actions */

  async newFolder(parentId) {
    const name = await promptDialog({
      title: parentId ? `New folder in “${this.folders.get(parentId)?.name}”` : 'New folder',
      label: 'Folder name',
      confirmText: 'Create',
    });
    if (!name) return;
    try {
      const { folder } = await api('POST', '/folders', { name, parent_id: parentId });
      this.folders.set(folder.id, folder);
      if (parentId) this.toggle(`f:${parentId}`, true);
      this.selected = `f:${folder.id}`;
      this.render();
    } catch (error) {
      toast(error.message, 'error');
    }
  },

  async deleteFolder(fid) {
    const folder = this.folders.get(fid);
    const ok = await confirmDialog({
      title: 'Delete folder?',
      message: `“${folder.name}” and everything inside it — all sub-folders and collections — will be permanently deleted.`,
    });
    if (!ok) return;
    try {
      const { deleted_folder_ids: ids } = await api('DELETE', `/folders/${fid}`);
      const deleted = new Set(ids);
      for (const collection of [...this.collections.values()]) {
        if (deleted.has(collection.folder_id)) {
          this.collections.delete(collection.id);
          this.full.delete(collection.id);
          Editor.onCollectionDeleted(collection.id);
        }
      }
      ids.forEach((id) => this.folders.delete(id));
      this.render();
      toast('Folder deleted.');
    } catch (error) {
      toast(error.message, 'error');
    }
  },

  async moveFolder(fid, parentId) {
    try {
      const { folder } = await api('PATCH', `/folders/${fid}`, { parent_id: parentId });
      this.folders.set(folder.id, folder);
      if (parentId) this.toggle(`f:${parentId}`, true);
      this.render();
    } catch (error) {
      toast(error.message, 'error');
    }
  },

  /* ------------------------------------------------------------ collection actions */

  async newCollection(folderId) {
    const name = await promptDialog({
      title: folderId ? `New collection in “${this.folders.get(folderId)?.name}”` : 'New collection',
      label: 'Collection name',
      confirmText: 'Create',
    });
    if (!name) return;
    try {
      const { collection } = await api('POST', '/collections', { name, folder_id: folderId });
      this.collections.set(collection.id, summary(collection));
      this.full.set(collection.id, collection);
      this.reveal(collection.id, null);
    } catch (error) {
      toast(error.message, 'error');
    }
  },

  async duplicateCollection(cid) {
    try {
      const { collection } = await api('POST', `/collections/${cid}/duplicate`);
      this.collections.set(collection.id, summary(collection));
      this.full.set(collection.id, collection);
      this.reveal(collection.id, null);
      toast(`Created “${collection.name}”.`);
    } catch (error) {
      toast(error.message, 'error');
    }
  },

  async deleteCollection(cid) {
    const collection = this.collections.get(cid);
    const ok = await confirmDialog({
      title: 'Delete collection?',
      message: `“${collection.name}” and all of its requests will be permanently deleted. Export it first if you may need it again.`,
    });
    if (!ok) return;
    try {
      await api('DELETE', `/collections/${cid}`);
      this.collections.delete(cid);
      this.full.delete(cid);
      Editor.onCollectionDeleted(cid);
      this.render();
      toast('Collection deleted.');
    } catch (error) {
      toast(error.message, 'error');
    }
  },

  async moveCollection(cid, folderId) {
    try {
      const collection = await this.patchCollection(cid, { folder_id: folderId });
      if (folderId) this.toggle(`f:${folderId}`, true);
      Editor.onCollectionChanged(collection.id);
    } catch {
      /* reported */
    }
  },

  async exportCollection(cid, format) {
    try {
      const data = await api('GET', `/collections/${cid}/export?format=${format}`);
      const name = this.collections.get(cid)?.name || 'collection';
      const fileName = format === 'postman' ? `${name}.postman_collection.json` : `${name}.collection.json`;
      const result = await window.desktop.files.saveJson(fileName, data);
      if (result.saved) toast(`Exported to ${result.filePath}`);
    } catch (error) {
      toast(error.message, 'error');
    }
  },

  /**
   * What an export covers: a collection, a folder inside one, or a sidebar
   * folder (every collection in it and its sub-folders). Null if nothing loaded.
   */
  async exportSources(node) {
    if (node.kind === 'collection') {
      const collection = await this.ensureCollection(node.cid);
      if (!collection) return null;
      return { title: collection.name, description: collection.description || '', sources: [{ collection, items: collection.items }] };
    }
    if (node.kind === 'reqfolder') {
      const collection = await this.ensureCollection(node.cid);
      if (!collection) return null;
      return {
        title: `${collection.name} – ${node.item.name}`,
        description: node.item.description || '',
        sources: [{ collection, items: node.item.items, tagPrefix: [node.item.name] }],
      };
    }
    if (node.kind === 'folder') {
      const folderIds = new Set([node.fid]);
      for (let grew = true; grew;) {
        grew = false;
        for (const folder of this.folders.values()) {
          if (!folderIds.has(folder.id) && folderIds.has(folder.parent_id)) {
            folderIds.add(folder.id);
            grew = true;
          }
        }
      }
      const cids = [...this.collections.values()].filter((c) => folderIds.has(c.folder_id ?? null)).map((c) => c.id);
      const sources = [];
      setSyncState(`Loading ${cids.length} collection${cids.length === 1 ? '' : 's'}…`);
      try {
        for (const cid of cids) {
          const collection = await this.ensureCollection(cid);
          if (collection) sources.push({ collection, items: collection.items, tagPrefix: [collection.name] });
        }
      } finally {
        setSyncState('');
      }
      return { title: this.folders.get(node.fid)?.name || 'API', description: '', sources };
    }
    return null;
  },

  /** OpenAPI / Kong YAML. */
  async exportYaml(node, format) {
    try {
      const target = await this.exportSources(node);
      if (!target) return;
      const { title, description, sources } = target;

      const result = format === 'kong' ? buildKongYaml(title, sources) : buildOpenApiYaml(title, sources, description);
      if (!result.operations) {
        toast('There are no requests with a URL to export here.', 'error');
        return;
      }
      const fileName = `${title}.${format === 'kong' ? 'kong' : 'openapi'}.yaml`;
      const saved = await window.desktop.files.saveText(fileName, result.yaml, { title: format === 'kong' ? 'Export Kong config' : 'Export OpenAPI', name: 'YAML', extensions: ['yaml', 'yml'] });
      if (saved.saved) {
        const extra = result.skipped ? ` ${result.skipped} duplicate or empty request${result.skipped === 1 ? ' was' : 's were'} left out.` : '';
        toast(`Exported ${result.operations} request${result.operations === 1 ? '' : 's'} to ${saved.filePath}.${extra}`);
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  },

  /** API document as a Word file. */
  async exportDocx(node) {
    try {
      const target = await this.exportSources(node);
      if (!target) return;
      const model = buildDocModel(target.title, target.sources, target.description);
      if (!model.endpoints.length) {
        toast('There are no requests to document here.', 'error');
        return;
      }
      setSyncState('Building document…');
      const saved = await window.desktop.files.saveDocx(`${target.title} - API documentation.docx`, model);
      if (saved.saved) toast(`Exported API document (${model.endpoints.length} request${model.endpoints.length === 1 ? '' : 's'}) to ${saved.filePath}.`);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setSyncState('');
    }
  },

  async importFiles(folderId) {
    const { files } = await window.desktop.files.openJson();
    let last = null;
    for (const file of files) {
      if (file.error) {
        toast(`${file.name}: ${file.error}`, 'error');
        continue;
      }
      try {
        setSyncState(`Importing ${file.name}…`);
        const { collection, source } = await api('POST', '/collections/import', { data: file.data, folder_id: folderId });
        this.collections.set(collection.id, summary(collection));
        this.full.set(collection.id, collection);
        last = collection;
        toast(`Imported “${collection.name}”${source === 'postman' ? ' from Postman' : ''}.`);
      } catch (error) {
        toast(`${file.name}: ${error.message}`, 'error');
      }
    }
    setSyncState('');
    if (last) this.reveal(last.id, null);
  },

  /* ------------------------------------------------------------ request / request-folder actions */

  async addRequest(cid, parentItemId) {
    const collection = await this.ensureCollection(cid);
    if (!collection) return;
    const name = await promptDialog({ title: 'New request', label: 'Request name', value: 'New request', confirmText: 'Create' });
    if (!name) return;
    const list = parentItemId ? findItem(collection.items, parentItemId)?.item.items : collection.items;
    if (!list) return;
    const request = newRequest(name);
    list.push(request);
    if (parentItemId) this.expanded.add(`i:${cid}:${parentItemId}`);
    try {
      await this.saveItems(cid);
      this.reveal(cid, request.id);
      Editor.openRequest(cid, request.id);
    } catch {
      /* reported */
    }
  },

  async addItemFolder(cid, parentItemId) {
    const collection = await this.ensureCollection(cid);
    if (!collection) return;
    const name = await promptDialog({ title: 'New folder', label: 'Folder name', confirmText: 'Create' });
    if (!name) return;
    const list = parentItemId ? findItem(collection.items, parentItemId)?.item.items : collection.items;
    if (!list) return;
    const folder = { id: uid(), type: 'folder', name, items: [] };
    list.push(folder);
    try {
      await this.saveItems(cid);
      this.reveal(cid, folder.id);
    } catch {
      /* reported */
    }
  },

  async duplicateItem(cid, itemId) {
    const collection = this.full.get(cid);
    const found = collection && findItem(collection.items, itemId);
    if (!found) return;
    const copy = withNewIds(clone(found.item));
    copy.name = `${found.item.name} copy`;
    found.list.splice(found.index + 1, 0, copy);
    try {
      await this.saveItems(cid);
      this.reveal(cid, copy.id);
    } catch {
      /* reported */
    }
  },

  async deleteItem(cid, itemId) {
    const collection = this.full.get(cid);
    const found = collection && findItem(collection.items, itemId);
    if (!found) return;
    const isFolder = found.item.type === 'folder';
    const ok = await confirmDialog({
      title: isFolder ? 'Delete folder?' : 'Delete request?',
      message: isFolder
        ? `“${found.item.name}” and every request inside it will be deleted.`
        : `“${found.item.name}” will be deleted.`,
    });
    if (!ok) return;
    const removedIds = collectIds(found.item);
    found.list.splice(found.index, 1);
    try {
      await this.saveItems(cid);
      removedIds.forEach((id) => Editor.onRequestDeleted(cid, id));
    } catch {
      /* reported */
    }
  },

  async rename(node) {
    let current;
    if (node.kind === 'folder') current = this.folders.get(node.fid)?.name;
    else if (node.kind === 'collection') current = this.collections.get(node.cid)?.name;
    else current = node.item.name;

    const name = await promptDialog({ title: 'Rename', label: 'Name', value: current || '' });
    if (!name || name === current) return;

    try {
      if (node.kind === 'folder') {
        const { folder } = await api('PATCH', `/folders/${node.fid}`, { name });
        this.folders.set(folder.id, folder);
        this.render();
      } else if (node.kind === 'collection') {
        await this.patchCollection(node.cid, { name });
        Editor.onCollectionChanged(node.cid);
      } else {
        await this.renameItem(node.cid, node.item.id, name);
      }
    } catch (error) {
      if (!(error instanceof ApiError)) toast(error.message, 'error');
    }
  },

  async renameItem(cid, itemId, name) {
    const found = findItem(this.full.get(cid)?.items || [], itemId);
    if (!found) return;
    found.item.name = name;
    await this.saveItems(cid);
    Editor.onRequestRenamed(cid, itemId, name);
  },

  /* ------------------------------------------------------------ drag & drop */

  attachDnD(el, node) {
    el.addEventListener('dragstart', (event) => {
      this.dragging = node;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', node.name);
      requestAnimationFrame(() => el.classList.add('dragging'));
    });
    el.addEventListener('dragend', () => {
      this.dragging = null;
      el.classList.remove('dragging');
      document.querySelectorAll('.drop-target, .drop-root').forEach((target) => target.classList.remove('drop-target', 'drop-root'));
    });
    el.addEventListener('dragover', (event) => {
      if (!this.canDrop(this.dragging, node)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      document.getElementById('tree').classList.remove('drop-root');
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      el.classList.remove('drop-target');
      const source = this.dragging;
      if (this.canDrop(source, node)) this.drop(source, node);
    });
  },

  initRootDrop() {
    const tree = document.getElementById('tree');
    tree.addEventListener('dragover', (event) => {
      const source = this.dragging;
      if (!source || !['folder', 'collection'].includes(source.kind)) return;
      event.preventDefault();
      tree.classList.add('drop-root');
    });
    tree.addEventListener('dragleave', (event) => {
      if (!tree.contains(event.relatedTarget)) tree.classList.remove('drop-root');
    });
    tree.addEventListener('drop', (event) => {
      tree.classList.remove('drop-root');
      const source = this.dragging;
      if (!source) return;
      event.preventDefault();
      if (source.kind === 'folder' && this.folders.get(source.fid)?.parent_id) this.moveFolder(source.fid, null);
      if (source.kind === 'collection' && this.collections.get(source.cid)?.folder_id) this.moveCollection(source.cid, null);
    });
  },

  canDrop(source, target) {
    if (!source || !target || source.key === target.key) return false;
    if (source.kind === 'folder') {
      return target.kind === 'folder'
        && !this.isFolderInside(target.fid, source.fid)
        && this.folders.get(source.fid)?.parent_id !== target.fid;
    }
    if (source.kind === 'collection') {
      return target.kind === 'folder' && this.collections.get(source.cid)?.folder_id !== target.fid;
    }
    // Requests and request folders move into a collection or a request folder.
    if (!['collection', 'reqfolder'].includes(target.kind)) return false;
    if (source.kind === 'reqfolder' && target.kind === 'reqfolder' && target.cid === source.cid
      && collectIds(source.item).includes(target.item.id)) return false;
    return true;
  },

  async drop(source, target) {
    if (source.kind === 'folder') return this.moveFolder(source.fid, target.fid);
    if (source.kind === 'collection') return this.moveCollection(source.cid, target.fid);

    const from = this.full.get(source.cid);
    const to = await this.ensureCollection(target.cid);
    const found = from && findItem(from.items, source.item.id);
    if (!found || !to) return;
    const destination = target.kind === 'collection' ? to.items : findItem(to.items, target.item.id)?.item.items;
    if (!destination || destination === found.list) return;

    found.list.splice(found.index, 1);
    destination.push(found.item);
    if (target.kind === 'reqfolder') this.expanded.add(`i:${target.cid}:${target.item.id}`);
    else this.expanded.add(`c:${target.cid}`);

    try {
      // Save the destination first so a failure never loses the item.
      await this.saveItems(target.cid);
      if (source.cid !== target.cid) {
        await this.saveItems(source.cid);
        collectIds(found.item).forEach((id) => Editor.onRequestMoved(source.cid, id, target.cid));
      }
    } catch {
      /* reported */
    }
  },
};

/* ---------------- plain helpers ---------------- */

function bySortThenName(a, b) {
  return (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name);
}

function summary(collection) {
  const { items, variables, auth, ...rest } = collection;
  return rest;
}

/** Finds an item anywhere in a collection's item tree. */
function findItem(items, id, parents = []) {
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item.id === id) return { item, list: items, index, parents };
    if (item.type === 'folder') {
      const found = findItem(item.items, id, [...parents, item]);
      if (found) return found;
    }
  }
  return null;
}

function collectIds(item) {
  return item.type === 'folder' ? [item.id, ...item.items.flatMap(collectIds)] : [item.id];
}

function withNewIds(item) {
  item.id = uid();
  if (item.type === 'folder') item.items.forEach(withNewIds);
  return item;
}

function newRequest(name) {
  return {
    id: uid(),
    type: 'request',
    name,
    method: 'GET',
    url: '',
    headers: [],
    body: { mode: 'none', raw: '', urlencoded: [], formdata: [] },
    auth: { type: 'inherit', bearer: { token: '' }, basic: { username: '', password: '' }, apikey: { key: '', value: '', in: 'header' } },
  };
}

let syncTimer;
function setSyncState(text) {
  const el = document.getElementById('sync-state');
  el.textContent = text;
  clearTimeout(syncTimer);
  if (text && !text.endsWith('…')) syncTimer = setTimeout(() => { el.textContent = ''; }, 2500);
}
