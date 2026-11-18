'use strict';

const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const DEFAULT_API_BASE_URL = 'https://api.sanjakarobar.com/api';
const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

const isDev = process.argv.includes('--dev');
let mainWindow = null;

/* ------------------------------------------------------------------ */
/* Settings and session (stored in the user's app-data folder)          */
/* ------------------------------------------------------------------ */

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const sessionFile = () => path.join(app.getPath('userData'), 'session.bin');

let settings = { apiBaseUrl: process.env.API_BASE_URL || DEFAULT_API_BASE_URL };
let session = null; // { token, user }

async function loadSettings() {
  try {
    const stored = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
    if (!process.env.API_BASE_URL && typeof stored.apiBaseUrl === 'string') {
      settings.apiBaseUrl = stored.apiBaseUrl;
    }
  } catch {
    /* first run */
  }
}

async function saveSettings() {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2));
}

async function loadSession() {
  try {
    const raw = await fs.readFile(sessionFile());
    const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.token === 'string') session = parsed;
  } catch {
    session = null;
  }
}

async function saveSession() {
  if (!session) {
    await fs.rm(sessionFile(), { force: true });
    return;
  }
  const text = JSON.stringify(session);
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8');
  await fs.mkdir(path.dirname(sessionFile()), { recursive: true });
  await fs.writeFile(sessionFile(), data);
}

function normaliseBaseUrl(value) {
  const url = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The server address must start with http:// or https://');
  return url.toString().replace(/\/+$/, '');
}

/* ------------------------------------------------------------------ */
/* Calls to our own backend (token never leaves the main process)       */
/* ------------------------------------------------------------------ */

async function backend({ method = 'GET', path: apiPath, body, auth = true }) {
  if (typeof apiPath !== 'string' || !apiPath.startsWith('/')) throw new Error('Invalid API path');
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && session?.token) headers.Authorization = `Bearer ${session.token}`;

  let response;
  try {
    response = await fetch(settings.apiBaseUrl + apiPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
  } catch (error) {
    return { ok: false, status: 0, data: { message: `Cannot reach the server (${settings.apiBaseUrl}). ${error.cause?.code || error.message}` } };
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: `Unexpected server response (${response.status}).` };
  }

  if (response.status === 401 && auth && session) {
    session = null;
    await saveSession();
    mainWindow?.webContents.send('session:expired');
  }

  return { ok: response.ok, status: response.status, data };
}

ipcMain.handle('backend:request', (_event, request) => backend(request));

ipcMain.handle('session:get', () => (session ? { user: session.user } : null));

ipcMain.handle('session:login', async (_event, credentials) => {
  const result = await backend({
    method: 'POST',
    path: '/auth/login',
    auth: false,
    body: { phone: credentials.phone, password: credentials.password, device_name: 'API Collections desktop' },
  });
  if (result.ok && result.data?.token) {
    session = { token: result.data.token, user: result.data.user };
    await saveSession();
    return { ok: true, user: session.user };
  }
  return { ok: false, status: result.status, data: result.data };
});

ipcMain.handle('session:register', async (_event, details) => {
  const result = await backend({
    method: 'POST',
    path: '/auth/register',
    auth: false,
    body: { ...details, device_name: 'API Collections desktop' },
  });
  if (result.ok && result.data?.token) {
    session = { token: result.data.token, user: result.data.user };
    await saveSession();
    return { ok: true, user: session.user };
  }
  return { ok: false, status: result.status, data: result.data };
});

ipcMain.handle('session:logout', async () => {
  if (session) {
    await backend({ method: 'POST', path: '/auth/logout' }).catch(() => {});
  }
  session = null;
  await saveSession();
  return true;
});

ipcMain.handle('settings:get', () => ({ ...settings, defaultApiBaseUrl: DEFAULT_API_BASE_URL }));

ipcMain.handle('settings:set', async (_event, next) => {
  settings.apiBaseUrl = normaliseBaseUrl(next.apiBaseUrl || DEFAULT_API_BASE_URL);
  await saveSettings();
  return { ...settings, defaultApiBaseUrl: DEFAULT_API_BASE_URL };
});

/* ------------------------------------------------------------------ */
/* Sending the user's requests (from Node, so no browser CORS limits)   */
/* ------------------------------------------------------------------ */

const inFlight = new Map();

ipcMain.handle('http:send', async (_event, request) => {
  const id = String(request.id);
  const controller = new AbortController();
  inFlight.set(id, controller);
  const timeout = setTimeout(() => controller.abort(new Error('Request timed out after 5 minutes')), 300000);
  const started = performance.now();

  try {
    const url = new URL(request.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http:// and https:// URLs can be sent.');

    let body = ['GET', 'HEAD'].includes(request.method) ? undefined : request.body ?? undefined;
    if (body && typeof body === 'object' && Array.isArray(body.formdata)) {
      const form = new FormData();
      for (const [key, value] of body.formdata) form.append(String(key), String(value));
      body = form; // fetch sets the multipart Content-Type with its boundary
    }

    const response = await fetch(url, {
      method: request.method,
      headers: request.headers,
      body,
      redirect: 'follow',
      signal: controller.signal,
    });

    const headersReceived = performance.now();
    const chunks = [];
    let size = 0;
    let truncated = false;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          truncated = true;
          controller.abort();
          break;
        }
        chunks.push(chunk);
      }
    }
    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const contentType = response.headers.get('content-type') || '';
    const isText = /json|text|xml|html|javascript|x-www-form-urlencoded|graphql/i.test(contentType) || !contentType;

    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      headers: [...response.headers.entries()],
      contentType,
      body: isText ? buffer.toString('utf8') : null,
      bodyBase64: isText ? null : buffer.toString('base64'),
      size,
      truncated,
      timeMs: Math.round(performance.now() - started),
      ttfbMs: Math.round(headersReceived - started),
    };
  } catch (error) {
    const cancelled = controller.signal.aborted && controller.signal.reason?.name === 'AbortError';
    return {
      ok: false,
      cancelled,
      error: cancelled ? 'Request cancelled.' : describeNetworkError(error),
      timeMs: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(timeout);
    inFlight.delete(id);
  }
});

ipcMain.handle('http:cancel', (_event, id) => {
  inFlight.get(String(id))?.abort();
  return true;
});

function describeNetworkError(error) {
  const code = error?.cause?.code;
  const messages = {
    ENOTFOUND: 'Could not resolve the host name.',
    ECONNREFUSED: 'The connection was refused.',
    ECONNRESET: 'The connection was reset.',
    ETIMEDOUT: 'The connection timed out.',
    CERT_HAS_EXPIRED: 'The server certificate has expired.',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'The server uses a self-signed certificate.',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The server certificate could not be verified.',
  };
  return messages[code] || error?.cause?.message || error?.message || 'The request failed.';
}

/* ------------------------------------------------------------------ */
/* Files: export and import                                            */
/* ------------------------------------------------------------------ */

ipcMain.handle('file:saveJson', async (_event, { suggestedName, data }) => {
  const safeName = String(suggestedName || 'collection.json').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export collection',
    defaultPath: path.join(app.getPath('documents'), safeName),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { saved: false };
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  return { saved: true, filePath };
});

ipcMain.handle('file:openJson', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import collection',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Collection JSON', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (canceled) return { files: [] };

  const files = [];
  for (const filePath of filePaths) {
    const name = path.basename(filePath);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_IMPORT_BYTES) {
        files.push({ name, error: 'File is larger than 25 MB.' });
        continue;
      }
      files.push({ name, data: JSON.parse(await fs.readFile(filePath, 'utf8')) });
    } catch (error) {
      files.push({ name, error: error instanceof SyntaxError ? 'Not a valid JSON file.' : error.message });
    }
  }
  return { files };
});

ipcMain.handle('shell:openExternal', (_event, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: 'API Collections',
    backgroundColor: '#0f1a14',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (!isDev) Menu.setApplicationMenu(null);

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Never navigate the app window away; open links in the browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  // The page asks before closing when tabs have unsaved changes.
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Close without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'Some open tabs have unsaved changes.',
      detail: 'If you close now, those changes will be lost.',
    });
    if (choice === 0) event.preventDefault();
  });

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

// Optional separate profile folder (useful for testing against another server).
if (process.env.API_COLLECTIONS_USER_DATA) app.setPath('userData', process.env.API_COLLECTIONS_USER_DATA);

app.whenReady().then(async () => {
  app.setAppUserModelId('com.delickate.api-collections');
  await loadSettings();
  await loadSession();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
