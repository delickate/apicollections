'use strict';

/**
 * Code snippets: turns a prepared request (the same one Send uses, with
 * collection variables and auth already applied) into ready-to-paste code.
 *
 *   codeSnippet(langId, prepared, bodyMode) -> string
 *   CODE_LANGUAGES                          -> [{ id, label }]
 */

/* ---------------- string literals per language ---------------- */

const lit = {
  sh: (s) => `'${String(s).replace(/'/g, `'\\''`)}'`,
  ps: (s) => `'${String(s).replace(/'/g, "''")}'`,
  js: (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`,
  json: (s) => JSON.stringify(String(s)), // valid in Python, Java, Go, C (escapes \n, ", \, \uXXXX)
  php: (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`,
  rb: (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`,
  cs: (s) => `@"${String(s).replace(/"/g, '""')}"`,
  dart: (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`,
  dartMulti: (s) => `'''${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$')}'''`,
  go: (s) => (String(s).includes('`') ? JSON.stringify(String(s)) : `\`${s}\``),
};

const indentAfterFirst = (text, pad) => text.split('\n').join(`\n${pad}`);
const baseName = (filePath) => String(filePath || 'file').split(/[\\/]/).pop() || 'file';

/* ---------------- JSON value -> language literal ---------------- */

function toPython(value, depth = 0) {
  const pad = '    '.repeat(depth + 1);
  const end = '    '.repeat(depth);
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return lit.json(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((v) => pad + toPython(v, depth + 1)).join(',\n')}\n${end}]`;
  }
  const entries = Object.entries(value);
  if (!entries.length) return '{}';
  return `{\n${entries.map(([k, v]) => `${pad}${lit.json(k)}: ${toPython(v, depth + 1)}`).join(',\n')}\n${end}}`;
}

function toPhp(value, depth = 0) {
  const pad = '    '.repeat(depth + 1);
  const end = '    '.repeat(depth);
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return lit.php(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((v) => pad + toPhp(v, depth + 1)).join(',\n')},\n${end}]`;
  }
  const entries = Object.entries(value);
  if (!entries.length) return '[]';
  return `[\n${entries.map(([k, v]) => `${pad}${lit.php(k)} => ${toPhp(v, depth + 1)}`).join(',\n')},\n${end}]`;
}

/* ---------------- normalised description of the request ---------------- */

function snippetSpec(prepared, bodyMode) {
  const method = prepared.method.toUpperCase();
  const headers = Object.entries(prepared.headers || {});
  const contentType = headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
  const spec = { method, url: prepared.url, headers, contentType, kind: 'none', raw: '', fields: [], parts: [], json: undefined };
  const canHaveBody = !['GET', 'HEAD'].includes(method);

  if (canHaveBody && bodyMode === 'formdata' && prepared.body && Array.isArray(prepared.body.formdata)) {
    spec.kind = 'multipart';
    spec.parts = prepared.body.formdata.map((p) => (typeof p.file === 'string'
      ? { key: p.key, file: p.file, name: baseName(p.file) }
      : { key: p.key, value: p.value ?? '' }));
  } else if (canHaveBody && typeof prepared.body === 'string' && prepared.body !== '') {
    spec.raw = prepared.body;
    if (bodyMode === 'urlencoded') {
      spec.kind = 'urlencoded';
      spec.fields = [...new URLSearchParams(prepared.body)];
    } else {
      spec.kind = 'raw';
      if (bodyMode === 'json') {
        try {
          spec.json = JSON.parse(prepared.body);
        } catch {
          /* not valid JSON: sent as typed */
        }
      }
    }
  }
  return spec;
}

const headersWithout = (spec, ...names) => spec.headers.filter(([k]) => !names.includes(k.toLowerCase()));
const hasDuplicateKeys = (pairs) => new Set(pairs.map(([k]) => k)).size !== pairs.length;
const textParts = (spec) => spec.parts.filter((p) => p.file === undefined);
const fileParts = (spec) => spec.parts.filter((p) => p.file !== undefined);

/* ---------------- generators ---------------- */

const GENERATORS = {
  curl(spec) {
    const lines = [`curl --location${spec.method === 'GET' ? '' : ` --request ${spec.method}`} ${lit.sh(spec.url)}`];
    for (const [k, v] of spec.headers) lines.push(`--header ${lit.sh(`${k}: ${v}`)}`);
    if (spec.kind === 'raw') lines.push(`--data-raw ${lit.sh(spec.json !== undefined ? JSON.stringify(spec.json, null, 2) : spec.raw)}`);
    if (spec.kind === 'urlencoded') for (const [k, v] of spec.fields) lines.push(`--data-urlencode ${lit.sh(`${k}=${v}`)}`);
    if (spec.kind === 'multipart') {
      for (const p of spec.parts) {
        lines.push(p.file !== undefined
          ? `--form ${lit.sh(`${p.key}=@"${p.file.replace(/"/g, '\\"')}"`)}`
          : `--form ${lit.sh(`${p.key}="${String(p.value).replace(/"/g, '\\"')}"`)}`);
      }
    }
    return lines.join(' \\\n');
  },

  powershell(spec) {
    const out = [];
    const headers = headersWithout(spec, 'content-type');
    if (headers.length) {
      out.push('$headers = @{');
      for (const [k, v] of headers) out.push(`    ${lit.ps(k)} = ${lit.ps(v)}`);
      out.push('}', '');
    }
    const args = [`-Uri ${lit.ps(spec.url)}`, `-Method ${spec.method}`];
    if (headers.length) args.push('-Headers $headers');
    if (spec.kind === 'raw') {
      out.push(`$body = ${lit.ps(spec.json !== undefined ? JSON.stringify(spec.json, null, 2) : spec.raw)}`, '');
      args.push('-Body $body');
      if (spec.contentType) args.push(`-ContentType ${lit.ps(spec.contentType)}`);
    } else if (spec.kind === 'urlencoded') {
      out.push(`$body = ${lit.ps(spec.raw)}`, '');
      args.push('-Body $body', `-ContentType ${lit.ps('application/x-www-form-urlencoded')}`);
    } else if (spec.kind === 'multipart') {
      out.push('# -Form needs PowerShell 7 or later', '$form = @{');
      for (const p of spec.parts) out.push(`    ${lit.ps(p.key)} = ${p.file !== undefined ? `Get-Item -Path ${lit.ps(p.file)}` : lit.ps(p.value)}`);
      out.push('}', '');
      args.push('-Form $form');
    }
    out.push(`$response = Invoke-RestMethod ${args.join(' ')}`, '$response | ConvertTo-Json -Depth 10');
    return out.join('\n');
  },

  fetch(spec) {
    const out = [];
    const opts = [`  method: ${lit.js(spec.method)},`];
    const headers = spec.kind === 'multipart' ? headersWithout(spec, 'content-type') : spec.headers;
    if (headers.length) opts.push(`  headers: {\n${headers.map(([k, v]) => `    ${lit.js(k)}: ${lit.js(v)},`).join('\n')}\n  },`);
    if (spec.kind === 'raw') {
      opts.push(spec.json !== undefined
        ? `  body: JSON.stringify(${indentAfterFirst(JSON.stringify(spec.json, null, 2), '  ')}),`
        : `  body: ${lit.js(spec.raw)},`);
    } else if (spec.kind === 'urlencoded') {
      out.push('const body = new URLSearchParams();');
      for (const [k, v] of spec.fields) out.push(`body.append(${lit.js(k)}, ${lit.js(v)});`);
      out.push('');
      opts.push('  body,');
    } else if (spec.kind === 'multipart') {
      out.push('const formData = new FormData();');
      for (const p of spec.parts) {
        out.push(p.file !== undefined
          ? `formData.append(${lit.js(p.key)}, fileInput.files[0], ${lit.js(p.name)}); // file: ${p.file}`
          : `formData.append(${lit.js(p.key)}, ${lit.js(p.value)});`);
      }
      out.push('');
      opts.push('  body: formData,');
    }
    out.push(`fetch(${lit.js(spec.url)}, {`, ...opts, '})',
      '  .then((response) => response.text())',
      '  .then((result) => console.log(result))',
      '  .catch((error) => console.error(error));');
    return out.join('\n');
  },

  axios(spec) {
    const out = ["const axios = require('axios');"];
    let headers = spec.headers.map(([k, v]) => `    ${lit.js(k)}: ${lit.js(v)},`);
    let data = null;
    if (spec.kind === 'raw') {
      data = spec.json !== undefined ? indentAfterFirst(JSON.stringify(spec.json, null, 2), '  ') : lit.js(spec.raw);
    } else if (spec.kind === 'urlencoded') {
      out.push('', 'const data = new URLSearchParams();');
      for (const [k, v] of spec.fields) out.push(`data.append(${lit.js(k)}, ${lit.js(v)});`);
      data = 'data';
    } else if (spec.kind === 'multipart') {
      out.splice(1, 0, "const FormData = require('form-data');", "const fs = require('fs');");
      out.push('', 'const data = new FormData();');
      for (const p of spec.parts) {
        out.push(p.file !== undefined
          ? `data.append(${lit.js(p.key)}, fs.createReadStream(${lit.js(p.file)}));`
          : `data.append(${lit.js(p.key)}, ${lit.js(p.value)});`);
      }
      headers = headersWithout(spec, 'content-type').map(([k, v]) => `    ${lit.js(k)}: ${lit.js(v)},`);
      headers.push('    ...data.getHeaders(),');
      data = 'data';
    }
    out.push('', 'axios({', `  method: ${lit.js(spec.method.toLowerCase())},`, `  url: ${lit.js(spec.url)},`, '  maxBodyLength: Infinity,');
    if (headers.length) out.push('  headers: {', ...headers, '  },');
    if (data) out.push(`  data: ${data},`);
    out.push('})',
      '  .then((response) => console.log(JSON.stringify(response.data)))',
      '  .catch((error) => console.error(error.response?.data ?? error.message));');
    return out.join('\n');
  },

  python(spec) {
    const out = ['import requests', '', `url = ${lit.json(spec.url)}`];
    const args = ['url'];
    let headers = spec.headers;
    if (spec.kind === 'raw' && spec.json !== undefined) {
      headers = headersWithout(spec, 'content-type');
      out.push(`payload = ${toPython(spec.json)}`);
      args.push('json=payload');
    } else if (spec.kind === 'raw') {
      out.push(`payload = ${lit.json(spec.raw)}`);
      args.push('data=payload');
    } else if (spec.kind === 'urlencoded') {
      headers = headersWithout(spec, 'content-type');
      out.push(hasDuplicateKeys(spec.fields)
        ? `payload = [\n${spec.fields.map(([k, v]) => `    (${lit.json(k)}, ${lit.json(v)}),`).join('\n')}\n]`
        : `payload = {\n${spec.fields.map(([k, v]) => `    ${lit.json(k)}: ${lit.json(v)},`).join('\n')}\n}`);
      args.push('data=payload');
    } else if (spec.kind === 'multipart') {
      headers = headersWithout(spec, 'content-type');
      out.push(`payload = {\n${textParts(spec).map((p) => `    ${lit.json(p.key)}: ${lit.json(p.value)},`).join('\n')}\n}`);
      out.push(`files = [\n${fileParts(spec).map((p) => `    (${lit.json(p.key)}, (${lit.json(p.name)}, open(${lit.json(p.file)}, "rb"))),`).join('\n')}\n]`);
      args.push('data=payload', 'files=files');
    }
    if (headers.length) {
      out.push(`headers = {\n${headers.map(([k, v]) => `    ${lit.json(k)}: ${lit.json(v)},`).join('\n')}\n}`);
      args.push('headers=headers');
    }
    out.push('', `response = requests.request(${lit.json(spec.method)}, ${args.join(', ')})`, '', 'print(response.status_code)', 'print(response.text)');
    return out.join('\n');
  },

  phpCurl(spec) {
    const opts = [
      `    CURLOPT_URL => ${lit.php(spec.url)},`,
      '    CURLOPT_RETURNTRANSFER => true,',
      '    CURLOPT_FOLLOWLOCATION => true,',
      '    CURLOPT_TIMEOUT => 30,',
      `    CURLOPT_CUSTOMREQUEST => ${lit.php(spec.method)},`,
    ];
    if (spec.method === 'HEAD') opts.push('    CURLOPT_NOBODY => true,');
    let headers = spec.headers;
    if (spec.kind === 'raw' || spec.kind === 'urlencoded') {
      const raw = spec.json !== undefined ? JSON.stringify(spec.json, null, 4) : spec.raw;
      opts.push(`    CURLOPT_POSTFIELDS => ${lit.php(raw)},`);
    } else if (spec.kind === 'multipart') {
      headers = headersWithout(spec, 'content-type');
      const parts = spec.parts.map((p) => (p.file !== undefined
        ? `        ${lit.php(p.key)} => new CURLFile(${lit.php(p.file)}),`
        : `        ${lit.php(p.key)} => ${lit.php(p.value)},`));
      opts.push(`    CURLOPT_POSTFIELDS => [\n${parts.join('\n')}\n    ],`);
    }
    if (headers.length) opts.push(`    CURLOPT_HTTPHEADER => [\n${headers.map(([k, v]) => `        ${lit.php(`${k}: ${v}`)},`).join('\n')}\n    ],`);
    return ['<?php', '', '$curl = curl_init();', '', 'curl_setopt_array($curl, [', ...opts, ']);', '',
      '$response = curl_exec($curl);', 'if ($response === false) {', '    echo \'cURL error: \' . curl_error($curl);', '}',
      'curl_close($curl);', '', 'echo $response;'].join('\n');
  },

  guzzle(spec) {
    const opts = ["    'http_errors' => false,"];
    let headers = spec.headers;
    // A PHP array cannot hold repeated keys, so repeated form fields go as the encoded body.
    const formAsBody = spec.kind === 'urlencoded' && hasDuplicateKeys(spec.fields);
    if (spec.kind === 'raw' || formAsBody) {
      if (spec.json !== undefined) {
        headers = headersWithout(spec, 'content-type');
        opts.push(`    'json' => ${indentAfterFirst(toPhp(spec.json), '    ')},`);
      } else {
        opts.push(`    'body' => ${lit.php(spec.raw)},`);
      }
    } else if (spec.kind === 'urlencoded') {
      headers = headersWithout(spec, 'content-type');
      opts.push(`    'form_params' => [\n${spec.fields.map(([k, v]) => `        ${lit.php(k)} => ${lit.php(v)},`).join('\n')}\n    ],`);
    } else if (spec.kind === 'multipart') {
      headers = headersWithout(spec, 'content-type');
      const parts = spec.parts.map((p) => (p.file !== undefined
        ? `        ['name' => ${lit.php(p.key)}, 'contents' => fopen(${lit.php(p.file)}, 'r'), 'filename' => ${lit.php(p.name)}],`
        : `        ['name' => ${lit.php(p.key)}, 'contents' => ${lit.php(p.value)}],`));
      opts.push(`    'multipart' => [\n${parts.join('\n')}\n    ],`);
    }
    if (headers.length) opts.splice(1, 0, `    'headers' => [\n${headers.map(([k, v]) => `        ${lit.php(k)} => ${lit.php(v)},`).join('\n')}\n    ],`);
    return ['<?php', '', "require 'vendor/autoload.php';", '', 'use GuzzleHttp\\Client;', '', '$client = new Client();', '',
      `$response = $client->request(${lit.php(spec.method)}, ${lit.php(spec.url)}, [`, ...opts, ']);', '',
      'echo $response->getStatusCode() . PHP_EOL;', 'echo $response->getBody();'].join('\n');
  },

  laravel(spec) {
    const chain = [];
    let headers = spec.headers;
    let data = null;
    if (spec.kind === 'raw' && spec.json !== null && typeof spec.json === 'object') {
      headers = headersWithout(spec, 'content-type');
      data = indentAfterFirst(toPhp(spec.json), '    ');
    } else if (spec.kind === 'raw' || (spec.kind === 'urlencoded' && hasDuplicateKeys(spec.fields))) {
      // Repeated form fields cannot live in a PHP array, so they go as the encoded body.
      headers = headersWithout(spec, 'content-type');
      chain.push(`->withBody(${lit.php(spec.raw)}, ${lit.php(spec.contentType || 'text/plain')})`);
    } else if (spec.kind === 'urlencoded') {
      headers = headersWithout(spec, 'content-type');
      chain.push('->asForm()');
      data = `[\n${spec.fields.map(([k, v]) => `        ${lit.php(k)} => ${lit.php(v)},`).join('\n')}\n    ]`;
    } else if (spec.kind === 'multipart') {
      headers = headersWithout(spec, 'content-type');
      for (const p of fileParts(spec)) chain.push(`->attach(${lit.php(p.key)}, file_get_contents(${lit.php(p.file)}), ${lit.php(p.name)})`);
      const text = textParts(spec);
      data = text.length ? `[\n${text.map((p) => `        ${lit.php(p.key)} => ${lit.php(p.value)},`).join('\n')}\n    ]` : null;
      if (!data && !fileParts(spec).length) chain.push('->asMultipart()');
    }
    if (headers.length) chain.unshift(`->withHeaders([\n${headers.map(([k, v]) => `        ${lit.php(k)} => ${lit.php(v)},`).join('\n')}\n    ])`);

    const verb = spec.method.toLowerCase();
    const args = [lit.php(spec.url)];
    if (data) args.push(data);
    chain.push(['get', 'post', 'put', 'patch', 'delete', 'head'].includes(verb)
      ? `->${verb}(${args.join(', ')})`
      : `->send(${lit.php(spec.method)}, ${lit.php(spec.url)})`);

    // Http::first(...)  then  ->next(...) on following lines; the last call ends the statement.
    const lines = chain.map((call, index) => (index === 0 ? `$response = Http::${call.slice(2)}` : `    ${call}`));
    lines[lines.length - 1] += ';';
    return ['use Illuminate\\Support\\Facades\\Http;', '', ...lines, '',
      '$status = $response->status();', '$data = $response->json(); // or $response->body()'].join('\n');
  },

  csharp(spec) {
    const out = ['using System.Net.Http.Headers;', '', 'using var client = new HttpClient();',
      `var request = new HttpRequestMessage(new HttpMethod(${lit.json(spec.method)}), ${lit.cs(spec.url)});`];
    for (const [k, v] of headersWithout(spec, 'content-type')) out.push(`request.Headers.TryAddWithoutValidation(${lit.cs(k)}, ${lit.cs(v)});`);
    if (spec.kind === 'raw') {
      const raw = spec.json !== undefined ? JSON.stringify(spec.json, null, 4) : spec.raw;
      out.push(`request.Content = new StringContent(${lit.cs(raw)});`);
      if (spec.contentType) out.push(`request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(${lit.cs(spec.contentType)});`);
    } else if (spec.kind === 'urlencoded') {
      out.push('request.Content = new FormUrlEncodedContent(new[]', '{',
        ...spec.fields.map(([k, v]) => `    new KeyValuePair<string, string>(${lit.cs(k)}, ${lit.cs(v)}),`), '});');
    } else if (spec.kind === 'multipart') {
      out.push('var content = new MultipartFormDataContent();');
      for (const p of spec.parts) {
        out.push(p.file !== undefined
          ? `content.Add(new StreamContent(File.OpenRead(${lit.cs(p.file)})), ${lit.cs(p.key)}, ${lit.cs(p.name)});`
          : `content.Add(new StringContent(${lit.cs(p.value)}), ${lit.cs(p.key)});`);
      }
      out.push('request.Content = content;');
    }
    out.push('', 'var response = await client.SendAsync(request);', 'Console.WriteLine((int)response.StatusCode);',
      'Console.WriteLine(await response.Content.ReadAsStringAsync());');
    return out.join('\n');
  },

  java(spec) {
    const out = ['// OkHttp 4.x (com.squareup.okhttp3:okhttp)', 'OkHttpClient client = new OkHttpClient().newBuilder().build();'];
    let body = 'null';
    if (spec.kind === 'raw') {
      const raw = spec.json !== undefined ? JSON.stringify(spec.json, null, 2) : spec.raw;
      out.push(`MediaType mediaType = MediaType.parse(${lit.json(spec.contentType || 'text/plain')});`,
        `RequestBody body = RequestBody.create(${lit.json(raw)}, mediaType);`);
      body = 'body';
    } else if (spec.kind === 'urlencoded') {
      out.push('RequestBody body = new FormBody.Builder()', ...spec.fields.map(([k, v]) => `    .add(${lit.json(k)}, ${lit.json(v)})`), '    .build();');
      body = 'body';
    } else if (spec.kind === 'multipart') {
      out.push('RequestBody body = new MultipartBody.Builder().setType(MultipartBody.FORM)');
      for (const p of spec.parts) {
        out.push(p.file !== undefined
          ? `    .addFormDataPart(${lit.json(p.key)}, ${lit.json(p.name)}, RequestBody.create(new File(${lit.json(p.file)}), MediaType.parse("application/octet-stream")))`
          : `    .addFormDataPart(${lit.json(p.key)}, ${lit.json(p.value)})`);
      }
      out.push('    .build();');
      body = 'body';
    } else if (['POST', 'PUT', 'PATCH'].includes(spec.method)) {
      out.push('RequestBody body = RequestBody.create("", null);');
      body = 'body';
    }
    const headers = spec.kind === 'raw' ? spec.headers : headersWithout(spec, 'content-type');
    out.push('Request request = new Request.Builder()', `    .url(${lit.json(spec.url)})`, `    .method(${lit.json(spec.method)}, ${body})`,
      ...headers.map(([k, v]) => `    .addHeader(${lit.json(k)}, ${lit.json(v)})`), '    .build();',
      'Response response = client.newCall(request).execute();', 'System.out.println(response.code());', 'System.out.println(response.body().string());');
    return out.join('\n');
  },

  go(spec) {
    const imports = new Set(['fmt', 'io', 'net/http']);
    const body = [];
    let payload = 'nil';
    if (spec.kind === 'raw' || spec.kind === 'urlencoded') {
      imports.add('strings');
      const raw = spec.json !== undefined ? JSON.stringify(spec.json, null, 2) : spec.raw;
      body.push(`\tpayload := strings.NewReader(${lit.go(raw)})`, '');
      payload = 'payload';
    } else if (spec.kind === 'multipart') {
      ['bytes', 'mime/multipart'].forEach((x) => imports.add(x));
      body.push('\tpayload := &bytes.Buffer{}', '\twriter := multipart.NewWriter(payload)');
      for (const p of spec.parts) {
        if (p.file === undefined) {
          body.push(`\t_ = writer.WriteField(${lit.json(p.key)}, ${lit.json(p.value)})`);
        } else {
          ['os', 'path/filepath'].forEach((x) => imports.add(x));
          body.push('\t{', `\t\tfile, err := os.Open(${lit.json(p.file)})`, '\t\tif err != nil {', '\t\t\tpanic(err)', '\t\t}', '\t\tdefer file.Close()',
            `\t\tpart, _ := writer.CreateFormFile(${lit.json(p.key)}, filepath.Base(file.Name()))`, '\t\t_, _ = io.Copy(part, file)', '\t}');
        }
      }
      body.push('\tif err := writer.Close(); err != nil {', '\t\tpanic(err)', '\t}', '');
      payload = 'payload';
    }
    body.push(`\treq, err := http.NewRequest(${lit.json(spec.method)}, ${lit.json(spec.url)}, ${payload})`, '\tif err != nil {', '\t\tpanic(err)', '\t}');
    const headers = spec.kind === 'multipart' ? headersWithout(spec, 'content-type') : spec.headers;
    for (const [k, v] of headers) body.push(`\treq.Header.Add(${lit.json(k)}, ${lit.json(v)})`);
    if (spec.kind === 'multipart') body.push('\treq.Header.Set("Content-Type", writer.FormDataContentType())');
    body.push('', '\tres, err := http.DefaultClient.Do(req)', '\tif err != nil {', '\t\tpanic(err)', '\t}', '\tdefer res.Body.Close()', '',
      '\tdata, err := io.ReadAll(res.Body)', '\tif err != nil {', '\t\tpanic(err)', '\t}', '\tfmt.Println(res.StatusCode)', '\tfmt.Println(string(data))');
    return ['package main', '', 'import (', ...[...imports].sort().map((x) => `\t"${x}"`), ')', '', 'func main() {', ...body, '}'].join('\n');
  },

  dart(spec) {
    const out = ["import 'package:http/http.dart' as http;", '', 'Future<void> main() async {'];
    const headerMap = (headers) => `{\n${headers.map(([k, v]) => `    ${lit.dart(k)}: ${lit.dart(v)},`).join('\n')}\n  }`;
    if (spec.kind === 'multipart') {
      out.push(`  var request = http.MultipartRequest(${lit.dart(spec.method)}, Uri.parse(${lit.dart(spec.url)}));`);
      const text = textParts(spec);
      if (text.length) out.push(`  request.fields.addAll({\n${text.map((p) => `    ${lit.dart(p.key)}: ${lit.dart(p.value)},`).join('\n')}\n  });`);
      for (const p of fileParts(spec)) out.push(`  request.files.add(await http.MultipartFile.fromPath(${lit.dart(p.key)}, ${lit.dart(p.file)}));`);
      const headers = headersWithout(spec, 'content-type');
      if (headers.length) out.push(`  request.headers.addAll(${headerMap(headers)});`);
    } else {
      out.push(`  var request = http.Request(${lit.dart(spec.method)}, Uri.parse(${lit.dart(spec.url)}));`);
      const headers = spec.kind === 'urlencoded' ? headersWithout(spec, 'content-type') : spec.headers;
      if (headers.length) out.push(`  request.headers.addAll(${headerMap(headers)});`);
      if (spec.kind === 'raw') out.push(`  request.body = ${lit.dartMulti(spec.json !== undefined ? JSON.stringify(spec.json, null, 2) : spec.raw)};`);
      if (spec.kind === 'urlencoded') out.push(`  request.bodyFields = {\n${spec.fields.map(([k, v]) => `    ${lit.dart(k)}: ${lit.dart(v)},`).join('\n')}\n  };`);
    }
    out.push('', '  http.StreamedResponse response = await request.send();', '  print(response.statusCode);',
      '  print(await response.stream.bytesToString());', '}');
    return out.join('\n');
  },

  ruby(spec) {
    const klass = { GET: 'Get', POST: 'Post', PUT: 'Put', PATCH: 'Patch', DELETE: 'Delete', HEAD: 'Head', OPTIONS: 'Options' }[spec.method] || 'Get';
    const out = ['require "uri"', '', 'require "net/http"', '', `url = URI(${lit.rb(spec.url)})`, '', 'http = Net::HTTP.new(url.host, url.port)'];
    if (spec.url.startsWith('https:')) out.push('http.use_ssl = true');
    out.push('', `request = Net::HTTP::${klass}.new(url)`);
    const headers = spec.kind === 'multipart' ? headersWithout(spec, 'content-type') : spec.headers;
    for (const [k, v] of headers) out.push(`request[${lit.rb(k)}] = ${lit.rb(v)}`);
    if (spec.kind === 'raw' || spec.kind === 'urlencoded') {
      out.push(`request.body = ${lit.rb(spec.json !== undefined ? JSON.stringify(spec.json, null, 2) : spec.raw)}`);
    } else if (spec.kind === 'multipart') {
      const parts = spec.parts.map((p) => (p.file !== undefined ? `  [${lit.rb(p.key)}, File.open(${lit.rb(p.file)})]` : `  [${lit.rb(p.key)}, ${lit.rb(p.value)}]`));
      out.push(`form_data = [\n${parts.join(',\n')}\n]`, "request.set_form form_data, 'multipart/form-data'");
    }
    out.push('', 'response = http.request(request)', 'puts response.code', 'puts response.read_body');
    return out.join('\n');
  },

  http(spec) {
    const url = new URL(spec.url);
    const out = [`${spec.method} ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.host}`];
    const boundary = '----FormBoundary7MA4YWxkTrZu0gW';
    const headers = spec.kind === 'multipart' ? headersWithout(spec, 'content-type') : spec.headers;
    for (const [k, v] of headers) out.push(`${k}: ${v}`);
    if (spec.kind === 'raw' || spec.kind === 'urlencoded') {
      out.push('', spec.json !== undefined ? JSON.stringify(spec.json, null, 2) : spec.raw);
    } else if (spec.kind === 'multipart') {
      out.push(`Content-Type: multipart/form-data; boundary=${boundary}`, '');
      for (const p of spec.parts) {
        out.push(`--${boundary}`);
        if (p.file !== undefined) {
          out.push(`Content-Disposition: form-data; name="${p.key}"; filename="${p.name}"`, 'Content-Type: application/octet-stream', '', `(contents of ${p.file})`);
        } else {
          out.push(`Content-Disposition: form-data; name="${p.key}"`, '', p.value);
        }
      }
      out.push(`--${boundary}--`);
    }
    return out.join('\n');
  },
};

const CODE_LANGUAGES = [
  { id: 'curl', label: 'cURL' },
  { id: 'http', label: 'HTTP' },
  { id: 'fetch', label: 'JavaScript – Fetch' },
  { id: 'axios', label: 'NodeJS – Axios' },
  { id: 'python', label: 'Python – Requests' },
  { id: 'phpCurl', label: 'PHP – cURL' },
  { id: 'guzzle', label: 'PHP – Guzzle' },
  { id: 'laravel', label: 'PHP – Laravel HTTP' },
  { id: 'csharp', label: 'C# – HttpClient' },
  { id: 'java', label: 'Java – OkHttp' },
  { id: 'go', label: 'Go – net/http' },
  { id: 'dart', label: 'Dart – http' },
  { id: 'ruby', label: 'Ruby – Net::HTTP' },
  { id: 'powershell', label: 'PowerShell' },
];

function codeSnippet(langId, prepared, bodyMode) {
  const generate = GENERATORS[langId] || GENERATORS.curl;
  return generate(snippetSpec(prepared, bodyMode));
}
