'use strict';

/**
 * API document (Word) export: turns collections into the document model that
 * the main process renders with the `docx` library (src/main/docx-export.js).
 *
 *   buildDocModel(title, sources, description) -> model
 *
 * `sources` has the same shape as for the YAML export. Secrets are masked:
 * variables, headers and auth values that look like credentials are shown as
 * <name> placeholders, so the document can be shared.
 */

const SECRET_RE = /pass|secret|token|api[-_]?key|apikey|auth|cookie|session|private|credential|signature/i;
const hasVar = (value) => /{{\s*[^{}]+?\s*}}/.test(String(value));

function maskValue(key, value) {
  if (!value || hasVar(value)) return value;
  return SECRET_RE.test(key) ? `<${key}>` : value;
}

function maskAuth(auth) {
  if (!auth) return auth;
  const next = clone(auth);
  if (next.bearer && next.bearer.token && !hasVar(next.bearer.token)) next.bearer.token = '<token>';
  if (next.basic && next.basic.password && !hasVar(next.basic.password)) next.basic.password = '<password>';
  if (next.apikey && next.apikey.value && !hasVar(next.apikey.value)) next.apikey.value = '<api-key>';
  return next;
}

function maskJson(value) {
  if (Array.isArray(value)) return value.map(maskJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === 'string' ? maskValue(k, v) : maskJson(v)]));
  }
  return value;
}

/** Body with credential-looking field values replaced by <name> placeholders. */
function maskBody(body) {
  if (!body) return body;
  const next = clone(body);
  for (const mode of ['urlencoded', 'formdata']) {
    if (Array.isArray(next[mode])) next[mode] = next[mode].map((f) => (f.type === 'file' ? f : { ...f, value: maskValue(f.key, f.value) }));
  }
  if ((next.mode === 'json' || next.mode === 'raw') && next.raw) {
    try {
      next.raw = JSON.stringify(maskJson(JSON.parse(next.raw)), null, 2);
    } catch {
      /* not JSON: left as typed */
    }
  }
  return next;
}

function maskCollection(collection) {
  return {
    ...collection,
    variables: (collection.variables || []).map((v) => ({ ...v, value: maskValue(v.key, v.value) })),
    auth: maskAuth(collection.auth),
  };
}

function authText(auth, inherited) {
  if (!auth || auth.type === 'none') return 'None';
  if (auth.type === 'inherit') return inherited ? `Inherited from collection — ${authText(inherited)}` : 'Inherited from collection';
  if (auth.type === 'bearer') return `Bearer token — header "Authorization: Bearer ${auth.bearer?.token || '<token>'}"`;
  if (auth.type === 'basic') return `Basic auth — username "${auth.basic?.username || ''}", password ${auth.basic?.password || '<password>'}`;
  if (auth.type === 'apikey') {
    const where = auth.apikey?.in === 'query' ? 'query parameter' : 'header';
    return `API key — ${where} "${auth.apikey?.key || ''}" = ${auth.apikey?.value || '<api-key>'}`;
  }
  return String(auth.type);
}

function bodyBlock(body, headers) {
  if (!body || body.mode === 'none') return null;
  const declared = headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1];
  if (body.mode === 'json' || body.mode === 'raw') {
    if (!body.raw) return null;
    let code = body.raw;
    if (body.mode === 'json') {
      try {
        code = JSON.stringify(JSON.parse(body.raw), null, 2);
      } catch {
        /* contains {{variables}} outside strings, or is not JSON: show as typed */
      }
    }
    return { contentType: declared || (body.mode === 'json' ? 'application/json' : 'text/plain'), code };
  }
  const fields = (body[body.mode] || []).filter((f) => f.enabled !== false && f.key);
  if (!fields.length) return null;
  return {
    contentType: body.mode === 'formdata' ? 'multipart/form-data' : 'application/x-www-form-urlencoded',
    fields: fields.map((f) => (f.type === 'file'
      ? [f.key, 'File', f.src ? `file: ${f.src.split(/[\\/]/).pop()}` : 'file']
      : [f.key, 'Text', f.value])),
  };
}

function preferredLanguage() {
  try {
    const id = localStorage.getItem('codeLanguage');
    if (CODE_LANGUAGES.some((x) => x.id === id)) return id;
  } catch {
    /* storage unavailable */
  }
  return 'curl';
}

function requestBlockModel(item, collection, maskedCollection, variables, depth, lang) {
  const headers = (item.headers || []).filter((h) => h.enabled && h.key).map((h) => [h.key, maskValue(h.key, h.value)]);
  const body = maskBody(item.body);
  const url = splitUrl(item.url, variables);

  const queryAt = String(item.url || '').indexOf('?');
  const query = queryAt < 0 ? [] : String(item.url).slice(queryAt + 1).split('#')[0].split('&').filter(Boolean).map((pair) => {
    const at = pair.indexOf('=');
    const key = decodeURIComponentSafe(at >= 0 ? pair.slice(0, at) : pair);
    return [key, maskValue(key, at >= 0 ? decodeURIComponentSafe(pair.slice(at + 1)) : '')];
  });

  let example = null;
  try {
    const masked = { ...item, body, auth: maskAuth(item.auth), headers: (item.headers || []).map((h) => ({ ...h, value: maskValue(h.key, h.value) })) };
    const prepared = prepareRequest(masked, maskedCollection);
    example = { language: CODE_LANGUAGES.find((x) => x.id === lang)?.label || 'cURL', code: codeSnippet(lang, prepared, item.body?.mode || 'none') };
  } catch {
    /* URL cannot be resolved (missing variable): no example */
  }

  return {
    type: 'request',
    level: Math.min(depth + 1, 4),
    name: item.name,
    method: item.method || 'GET',
    url: item.url,
    description: item.description || '',
    auth: item.auth && item.auth.type !== 'inherit' ? authText(maskAuth(item.auth)) : null,
    pathParams: url.pathParams.map((p) => [p.name, p.example !== undefined ? maskValue(p.name, p.example) : '']),
    query,
    headers,
    body: ['GET', 'HEAD'].includes(String(item.method).toUpperCase()) ? null : bodyBlock(body, headers),
    example,
    endpoint: [item.method || 'GET', url.path, item.name],
  };
}

function collectionInfo(collection, maskedCollection, variables, items) {
  const servers = [...new Set(walkRequests(items).filter(({ item }) => item.url).map(({ item }) => splitUrl(item.url, variables).server))];
  return {
    description: collection.description || '',
    servers,
    auth: authText(maskedCollection.auth),
    variables: (maskedCollection.variables || []).filter((v) => v.enabled !== false && v.key).map((v) => [v.key, v.value]),
  };
}

function buildDocModel(title, sources, description = '') {
  const lang = preferredLanguage();
  const blocks = [];
  const endpoints = [];
  const single = sources.length === 1;

  const walk = (items, ctx, depth) => {
    for (const item of items || []) {
      if (item.type === 'folder') {
        blocks.push({ type: 'folder', level: Math.min(depth + 1, 3), name: item.name, description: item.description || '' });
        walk(item.items, ctx, depth + 1);
      } else if (item.type === 'request') {
        const block = requestBlockModel(item, ctx.collection, ctx.masked, ctx.variables, depth, lang);
        endpoints.push(block.endpoint);
        delete block.endpoint;
        blocks.push(block);
      }
    }
  };

  let info = null;
  for (const { collection, items } of sources) {
    const masked = maskCollection(collection);
    const ctx = { collection, masked, variables: variablesOf(collection) };
    if (single) {
      info = collectionInfo(collection, masked, ctx.variables, items);
      if (description) info.description = description;
      walk(items, ctx, 0);
    } else {
      // Several collections (a sidebar folder): each is a top-level section with its own details.
      blocks.push({ type: 'folder', level: 1, name: collection.name, info: collectionInfo(collection, masked, ctx.variables, items) });
      walk(items, ctx, 1);
    }
  }

  return {
    title,
    generatedAt: new Date().toLocaleString(),
    info,
    endpoints,
    blocks,
  };
}
