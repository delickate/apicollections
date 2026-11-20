'use strict';

/**
 * Exports requests as YAML for API gateways and docs tools:
 *
 *   buildOpenApiYaml(title, sources, description) -> { yaml, operations, skipped }
 *   buildKongYaml(title, sources)                 -> { yaml, operations, skipped }
 *
 * `sources` is a list of { collection, items, tagPrefix } — a whole collection,
 * one folder of it, or several collections (exporting a sidebar folder).
 *
 * URL mapping: a leading {{variable}} (e.g. {{base_url}}/users) or the scheme
 * and host become the server; the rest becomes the path. Other {{variables}}
 * and :params in the path become OpenAPI path parameters ({id}).
 */

/* ---------------- YAML writer (enough for OpenAPI / decK files) ---------------- */

const YAML_RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i;

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  const text = String(value);
  if (/^[A-Za-z_/][A-Za-z0-9_ ./()-]*$/.test(text) && !/ $/.test(text) && !YAML_RESERVED.test(text)) return text;
  return JSON.stringify(text); // a JSON string is a valid YAML double-quoted scalar
}

const isBlock = (value) => value !== null && typeof value === 'object' && (Array.isArray(value) ? value.length > 0 : Object.keys(value).some((k) => value[k] !== undefined));
const inline = (value) => (Array.isArray(value) ? '[]' : value !== null && typeof value === 'object' ? '{}' : yamlScalar(value));

function yamlBlock(value, indent) {
  const pad = ' '.repeat(indent);
  const lines = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isBlock(item)) {
        lines.push(`${pad}- ${inline(item)}`);
      } else {
        const inner = yamlBlock(item, indent + 2);
        lines.push(`${pad}- ${inner.slice(indent + 2)}`);
      }
    }
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (!isBlock(item)) lines.push(`${pad}${yamlScalar(key)}: ${inline(item)}`);
      else lines.push(`${pad}${yamlScalar(key)}:\n${yamlBlock(item, indent + 2)}`);
    }
  }
  return lines.join('\n');
}

function toYaml(value) {
  return `${yamlBlock(value, 0)}\n`;
}

/* ---------------- helpers ---------------- */

const VAR_RE = /{{\s*([^{}]+?)\s*}}/g;
const safeName = (name) => String(name).trim().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'param';

function slug(text, fallback = 'item') {
  return String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || fallback;
}

function camelId(text) {
  const words = String(text).normalize('NFKD').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'operation';
  const id = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
  return /^[0-9]/.test(id) ? `op${id}` : id;
}

function unique(base, used) {
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}${base.includes('-') || base.includes('_') ? '-' : ''}${n}`;
  used.add(name);
  return name;
}

function inferSchema(value) {
  if (value === null) return { type: 'string', nullable: true };
  if (Array.isArray(value)) return { type: 'array', items: value.length ? inferSchema(value[0]) : {} };
  if (typeof value === 'object') {
    const properties = {};
    for (const [key, item] of Object.entries(value)) properties[key] = inferSchema(item);
    return Object.keys(properties).length ? { type: 'object', properties } : { type: 'object' };
  }
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  return { type: 'string' };
}

/** Collects every request in `items`, with the folder names leading to it. */
function walkRequests(items, trail = [], out = []) {
  for (const item of items || []) {
    if (item.type === 'folder') walkRequests(item.items, [...trail, item.name], out);
    else if (item.type === 'request') out.push({ item, trail });
  }
  return out;
}

/** Splits a request URL into server, OpenAPI path, path params and query params. */
function splitUrl(rawUrl, variables) {
  const sub = (text) => substitute(text, variables);
  const raw = String(rawUrl || '').trim();
  const queryAt = raw.indexOf('?');
  const beforeQuery = (queryAt >= 0 ? raw.slice(0, queryAt) : raw).split('#')[0];
  const queryText = queryAt >= 0 ? raw.slice(queryAt + 1).split('#')[0] : '';

  let server = '';
  let pathPart = '';
  const lead = beforeQuery.match(/^{{\s*([^{}]+?)\s*}}/);
  if (lead && variables.has(lead[1]) && /^[a-z][a-z0-9+.-]*:\/\//i.test(sub(lead[0]))) {
    server = sub(lead[0]);
    pathPart = beforeQuery.slice(lead[0].length);
  } else if (lead && !/^[a-z][a-z0-9+.-]*:\/\//i.test(sub(lead[0]))) {
    // Leading variable with no value (or not a URL): it stays a server variable, the rest is the path.
    server = lead[0];
    pathPart = beforeQuery.slice(lead[0].length);
  } else {
    // Resolve variables in the host part only; keep the ones in the path as parameters.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(beforeQuery) ? beforeQuery : `http://${beforeQuery}`;
    const match = withScheme.match(/^([^/]*\/\/[^/]*)(.*)$/) || [null, withScheme, ''];
    server = sub(match[1]);
    pathPart = match[2];
  }
  // A server URL that still has {{x}} becomes an OpenAPI server variable {x}.
  const serverVars = {};
  server = server.replace(/\/+$/, '').replace(VAR_RE, (_m, name) => {
    serverVars[safeName(name)] = { default: String(variables.get(name) ?? '') };
    return `{${safeName(name)}}`;
  });
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(server) && !server.startsWith('{')) server = `http://${server}`;

  const pathParams = [];
  const seen = new Set();
  const addParam = (name, example) => {
    const clean = safeName(name);
    if (!seen.has(clean)) {
      seen.add(clean);
      pathParams.push({ name: clean, example });
    }
    return `{${clean}}`;
  };
  let path = pathPart
    .replace(VAR_RE, (_m, name) => addParam(name, variables.get(name)))
    .replace(/(^|\/):([A-Za-z_][A-Za-z0-9_]*)/g, (_m, slash, name) => `${slash}${addParam(name)}`)
    .replace(/\/{2,}/g, '/');
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, '');

  const query = [];
  for (const pair of queryText.split('&')) {
    if (!pair) continue;
    const at = pair.indexOf('=');
    const name = decodeURIComponentSafe(at >= 0 ? pair.slice(0, at) : pair);
    const value = at >= 0 ? decodeURIComponentSafe(sub(pair.slice(at + 1))) : '';
    if (name && !query.some((q) => q.name === name)) query.push({ name, example: value });
  }
  return { server, serverVars, path, pathParams, query };
}

function decodeURIComponentSafe(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

/** Every request in the sources, as a flat operation list (duplicates of method + path dropped). */
function collectOperations(sources) {
  const operations = [];
  const seen = new Set();
  let skipped = 0;
  for (const { collection, items, tagPrefix = [] } of sources) {
    const variables = variablesOf(collection);
    for (const { item, trail } of walkRequests(items)) {
      const url = splitUrl(item.url, variables);
      const method = String(item.method || 'GET').toUpperCase();
      const key = `${method} ${url.server} ${url.path}`;
      if (!item.url || seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      const auth = !item.auth || item.auth.type === 'inherit' ? (collection.auth || { type: 'none' }) : item.auth;
      const tagParts = [...tagPrefix, ...trail];
      operations.push({
        method,
        name: item.name || `${method} ${url.path}`,
        description: item.description || '',
        tag: tagParts.length ? tagParts.join(' / ') : collection.name,
        ...url,
        headers: (item.headers || []).filter((h) => h.enabled && h.key),
        body: item.body || { mode: 'none' },
        auth,
        variables,
      });
    }
  }
  return { operations, skipped };
}

/* ---------------- OpenAPI 3.0 ---------------- */

const SKIPPED_HEADERS = new Set(['content-type', 'authorization', 'accept', 'content-length', 'host']);

function securityFor(auth, schemes) {
  if (auth.type === 'bearer') {
    schemes.bearerAuth = { type: 'http', scheme: 'bearer' };
    return [{ bearerAuth: [] }];
  }
  if (auth.type === 'basic') {
    schemes.basicAuth = { type: 'http', scheme: 'basic' };
    return [{ basicAuth: [] }];
  }
  if (auth.type === 'apikey' && auth.apikey?.key) {
    const where = auth.apikey.in === 'query' ? 'query' : 'header';
    const name = auth.apikey.key;
    let id = `apiKey_${safeName(name)}`;
    if (where === 'query') id += '_query';
    schemes[id] = { type: 'apiKey', in: where, name };
    return [{ [id]: [] }];
  }
  return null;
}

function requestBodyFor(op) {
  const { body, variables } = op;
  const sub = (text) => substitute(text, variables);
  const declaredType = op.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value;

  if (body.mode === 'json') {
    let example;
    try {
      example = JSON.parse(sub(body.raw));
    } catch {
      example = undefined;
    }
    const media = example === undefined ? { schema: { type: 'object' } } : { schema: inferSchema(example), example };
    return { content: { 'application/json': media } };
  }
  if (body.mode === 'raw' && body.raw) {
    return { content: { [declaredType || 'text/plain']: { schema: { type: 'string' }, example: sub(body.raw) } } };
  }
  if (body.mode === 'urlencoded' || body.mode === 'formdata') {
    const fields = (body[body.mode] || []).filter((f) => f.enabled !== false && f.key);
    if (!fields.length) return undefined;
    const properties = {};
    for (const field of fields) {
      properties[field.key] = field.type === 'file'
        ? { type: 'string', format: 'binary' }
        : { type: 'string', example: sub(field.value) };
    }
    const type = body.mode === 'formdata' ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
    return { content: { [type]: { schema: { type: 'object', properties } } } };
  }
  return undefined;
}

function buildOpenApiYaml(title, sources, description = '') {
  const { operations, skipped } = collectOperations(sources);

  // The server most requests use is the default; the rest are set per operation.
  const serverCounts = new Map();
  for (const op of operations) serverCounts.set(op.server, (serverCounts.get(op.server) || 0) + 1);
  const mainServer = [...serverCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const serverEntry = (op) => (Object.keys(op.serverVars).length ? { url: op.server, variables: op.serverVars } : { url: op.server });

  const paths = {};
  const tags = [];
  const schemes = {};
  const usedIds = new Set();

  for (const op of operations) {
    if (!tags.includes(op.tag)) tags.push(op.tag);
    const parameters = [
      ...op.pathParams.map((p) => ({ name: p.name, in: 'path', required: true, schema: { type: 'string' }, example: p.example || undefined })),
      ...op.query.map((q) => ({ name: q.name, in: 'query', schema: { type: 'string' }, example: q.example || undefined })),
      ...op.headers
        .filter((h) => !SKIPPED_HEADERS.has(h.key.toLowerCase()))
        .filter((h) => !(op.auth.type === 'apikey' && h.key.toLowerCase() === String(op.auth.apikey?.key).toLowerCase()))
        .map((h) => ({ name: h.key, in: 'header', schema: { type: 'string' }, example: substitute(h.value, op.variables) || undefined })),
    ];

    const operation = {
      tags: [op.tag],
      summary: op.name,
      description: op.description || undefined,
      operationId: unique(camelId(op.name), usedIds),
      servers: op.server !== mainServer ? [serverEntry(op)] : undefined,
      parameters: parameters.length ? parameters : undefined,
      requestBody: ['GET', 'HEAD'].includes(op.method) ? undefined : requestBodyFor(op),
      security: securityFor(op.auth, schemes) || undefined,
      responses: { 200: { description: 'Successful response' } },
    };

    paths[op.path] = paths[op.path] || {};
    paths[op.path][op.method.toLowerCase()] = operation;
  }

  const mainOp = operations.find((op) => op.server === mainServer);
  const spec = {
    openapi: '3.0.3',
    info: { title, description: description || undefined, version: '1.0.0' },
    servers: mainOp ? [serverEntry(mainOp)] : undefined,
    tags: tags.map((name) => ({ name })),
    paths,
    components: Object.keys(schemes).length ? { securitySchemes: schemes } : undefined,
  };
  return { yaml: toYaml(spec), operations: operations.length, skipped };
}

/* ---------------- Kong declarative config (decK, Kong 3.x) ---------------- */

const escapeRegex = (text) => text.replace(/[.*+?^$()|[\]\\]/g, '\\$&');

function kongPathRegex(path) {
  // /users/{id}/posts -> ~/users/(?<id>[^/]+)/posts$   (anchored, so routes do not shadow each other)
  const pattern = path.split(/({[^{}]+})/).map((part) => {
    const param = part.match(/^{([^{}]+)}$/);
    if (!param) return escapeRegex(part);
    const name = param[1].replace(/[^A-Za-z0-9_]/g, '_').replace(/^([0-9])/, '_$1');
    return `(?<${name}>[^/]+)`;
  }).join('');
  return `~${pattern}$`;
}

function buildKongYaml(title, sources) {
  const { operations, skipped } = collectOperations(sources);
  const services = [];
  const byServer = new Map();
  const usedServiceNames = new Set();
  const usedRouteNames = new Set();

  for (const op of operations) {
    // Kong needs a concrete upstream URL; server variables fall back to their names.
    const url = op.server.replace(/{([^{}]+)}/g, '$1');
    let service = byServer.get(url);
    if (!service) {
      let host = url;
      try {
        host = new URL(url).host;
      } catch {
        /* keep url */
      }
      const base = byServer.size === 0 ? slug(title, 'api') : slug(`${title}-${host}`, 'api');
      service = { name: unique(base, usedServiceNames), url, routes: [] };
      byServer.set(url, service);
      services.push(service);
    }
    const route = {
      name: unique(`${service.name}.${slug(op.name, op.method.toLowerCase())}`, usedRouteNames),
      methods: [op.method],
      paths: [kongPathRegex(op.path)],
      strip_path: false,
      tags: [slug(op.tag, 'default')],
    };
    service.routes.push(route);
  }

  const header = [
    `# Kong declarative configuration for "${title}"`,
    '# Load with:  deck gateway sync kong.yaml   (or: deck sync -s kong.yaml on older decK)',
    '# Routes match exact paths; path parameters are regex captures. Add plugins (auth, rate limiting) as needed.',
    '',
  ].join('\n');
  return { yaml: header + toYaml({ _format_version: '3.0', services }), operations: operations.length, skipped };
}
