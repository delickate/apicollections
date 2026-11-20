'use strict';

/**
 * Builds a Word (.docx) API document from the model the renderer sends
 * (see src/renderer/js/docs-export.js for its shape).
 */
const {
  AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, Packer, PageNumber,
  Paragraph, ShadingType, Table, TableCell, TableLayoutType, TableRow, TextRun, WidthType,
} = require('docx');

const PAGE_WIDTH = 9026; // A4 width minus 1" margins, in twips
const MAX_CODE_LINES = 400;
const FONT = 'Calibri';
const MONO = 'Consolas';
const GREEN = '065F46';
const MUTED = '5B6B63';
const BORDER = 'D5DED9';
const METHOD_COLORS = { GET: '059669', POST: 'D97706', PUT: '2563EB', PATCH: '7C3AED', DELETE: 'DC2626' };
const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5];

/* ---------------- input cleaning (the model comes from the renderer) ---------------- */

const clean = (value, max = 20000) => String(value ?? '')
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g, '')
  .replace(/\t/g, '    ')
  .slice(0, max);
const list = (value, max = 500) => (Array.isArray(value) ? value.slice(0, max) : []);
const rows = (value) => list(value).filter(Array.isArray).map((row) => row.map((cell) => clean(cell, 5000)));

/* ---------------- building blocks ---------------- */

const text = (value, opts = {}) => new TextRun({ text: clean(value), font: FONT, ...opts });

function para(children, opts = {}) {
  return new Paragraph({ children: Array.isArray(children) ? children : [children], spacing: { after: 120 }, ...opts });
}

function heading(value, level) {
  return new Paragraph({ heading: HEADINGS[Math.max(0, Math.min(level, HEADINGS.length - 1))], children: [new TextRun({ text: clean(value, 500) })] });
}

function label(value) {
  return para(text(value, { bold: true, color: GREEN, size: 20 }), { spacing: { before: 160, after: 60 }, keepNext: true });
}

const cellBorders = {
  top: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
  left: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
  right: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
};

function cell(content, width, { header = false, mono = false, color } = {}) {
  const lines = clean(content, 5000).split('\n');
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: cellBorders,
    shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: 'E7F3EE' } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: lines.map((line) => new Paragraph({
      children: [new TextRun({ text: line, font: mono ? MONO : FONT, size: mono ? 18 : 20, bold: header, color: header ? GREEN : color })],
    })),
  });
}

/** A table with a header row; `widths` are fractions of the page width. */
function table(headers, body, widths, monoColumns = []) {
  const dxa = widths.map((w) => Math.round(w * PAGE_WIDTH));
  return new Table({
    width: { size: PAGE_WIDTH, type: WidthType.DXA },
    columnWidths: dxa,
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, dxa[i], { header: true })) }),
      ...body.map((row) => new TableRow({
        cantSplit: true,
        children: headers.map((_h, i) => (row[i] && typeof row[i] === 'object' && !Array.isArray(row[i])
          ? cell(row[i].text, dxa[i], { mono: monoColumns.includes(i), color: row[i].color })
          : cell(row[i] ?? '', dxa[i], { mono: monoColumns.includes(i) }))),
      })),
    ],
  });
}

/** Monospace block in a shaded box. */
function codeBlock(code) {
  let lines = clean(code, 400000).split('\n');
  if (lines.length > MAX_CODE_LINES) lines = [...lines.slice(0, MAX_CODE_LINES), `… ${lines.length - MAX_CODE_LINES} more lines`];
  return new Table({
    width: { size: PAGE_WIDTH, type: WidthType.DXA },
    columnWidths: [PAGE_WIDTH],
    layout: TableLayoutType.FIXED,
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: PAGE_WIDTH, type: WidthType.DXA },
        borders: cellBorders,
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F4F7F5' },
        margins: { top: 100, bottom: 100, left: 140, right: 140 },
        children: lines.map((line) => new Paragraph({ children: [new TextRun({ text: line, font: MONO, size: 17 })] })),
      })],
    })],
  });
}

const spacer = () => new Paragraph({ children: [], spacing: { after: 60 } });

function methodRun(method) {
  const m = clean(method, 10).toUpperCase();
  return new TextRun({ text: `${m} `, font: MONO, bold: true, size: 22, color: METHOD_COLORS[m] || '64748B' });
}

/* ---------------- sections ---------------- */

function infoBlock(info, out, level) {
  if (!info) return;
  if (info.description) clean(info.description).split(/\n{2,}/).forEach((p) => out.push(para(text(p))));
  const servers = list(info.servers, 20).map((s) => clean(s, 2000)).filter(Boolean);
  if (servers.length) {
    out.push(label(servers.length > 1 ? 'Base URLs' : 'Base URL'));
    servers.forEach((s) => out.push(para(text(s, { font: MONO, size: 20 }), { spacing: { after: 40 } })));
  }
  if (info.auth) {
    out.push(label('Authentication'));
    out.push(para(text(info.auth)));
  }
  const variables = rows(info.variables);
  if (variables.length) {
    out.push(label('Variables'));
    out.push(table(['Variable', 'Value'], variables.map(([k, v]) => [`{{${k}}}`, v]), [0.35, 0.65], [0, 1]), spacer());
  }
  if (level !== undefined) out.push(spacer());
}

function requestBlock(block, out) {
  out.push(heading(block.name || 'Request', block.level));
  out.push(new Paragraph({
    children: [methodRun(block.method), new TextRun({ text: clean(block.url, 4000), font: MONO, size: 20 })],
    spacing: { after: 120 },
    keepNext: true,
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F4F7F5' },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: METHOD_COLORS[clean(block.method, 10).toUpperCase()] || '64748B', space: 6 } },
  }));
  if (block.description) clean(block.description).split(/\n{2,}/).forEach((p) => out.push(para(text(p))));
  if (block.auth) out.push(para([text('Authentication: ', { bold: true }), text(block.auth)]));

  const pathParams = rows(block.pathParams);
  if (pathParams.length) {
    out.push(label('Path parameters'));
    out.push(table(['Name', 'Example'], pathParams, [0.35, 0.65], [0, 1]));
  }
  const query = rows(block.query);
  if (query.length) {
    out.push(label('Query parameters'));
    out.push(table(['Name', 'Value'], query, [0.35, 0.65], [0, 1]));
  }
  const headers = rows(block.headers);
  if (headers.length) {
    out.push(label('Headers'));
    out.push(table(['Header', 'Value'], headers, [0.35, 0.65], [0, 1]));
  }

  const body = block.body;
  if (body && typeof body === 'object') {
    out.push(label(`Request body${body.contentType ? ` (${clean(body.contentType, 200)})` : ''}`));
    const fields = rows(body.fields);
    if (fields.length) {
      out.push(table(['Field', 'Type', 'Value'], fields.map(([k, type, v]) => [k, type, type === 'File' ? { text: v, color: MUTED } : v]), [0.3, 0.12, 0.58], [0, 2]));
    } else if (body.code) {
      out.push(codeBlock(body.code));
    }
  }

  if (block.example && block.example.code) {
    out.push(label(`Example request — ${clean(block.example.language, 100)}`));
    out.push(codeBlock(block.example.code));
  }
  out.push(spacer());
}

/* ---------------- document ---------------- */

async function buildDocx(model) {
  const title = clean(model?.title, 300) || 'API documentation';
  const out = [];

  out.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: title })] }));
  out.push(para(text(`API documentation · Generated ${clean(model?.generatedAt, 100)}`, { color: MUTED, size: 20 }), { spacing: { after: 240 } }));

  if (model?.info) {
    out.push(heading('Overview', 0));
    infoBlock(model.info, out);
  }

  const endpoints = list(model?.endpoints, 5000).filter(Array.isArray);
  if (endpoints.length) {
    out.push(heading(`Endpoints (${endpoints.length})`, 0));
    out.push(table(['Method', 'Endpoint', 'Name'],
      endpoints.map(([method, path, name]) => [{ text: clean(method, 10).toUpperCase(), color: METHOD_COLORS[clean(method, 10).toUpperCase()] || '64748B' }, path, name]),
      [0.12, 0.5, 0.38], [0, 1]), spacer());
  }

  out.push(heading('Reference', 0));
  for (const block of list(model?.blocks, 10000)) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'folder') {
      out.push(heading(block.name || 'Folder', block.level));
      infoBlock(block.info || (block.description ? { description: block.description } : null), out, block.level);
    } else if (block.type === 'request') {
      requestBlock(block, out);
    }
  }

  const doc = new Document({
    creator: 'API Collections',
    title,
    description: 'API documentation',
    styles: {
      default: {
        document: { run: { font: FONT, size: 21, color: '1F2A24' } },
        title: { run: { font: FONT, size: 52, bold: true, color: '064E3B' }, paragraph: { spacing: { after: 80 } } },
        heading1: { run: { font: FONT, size: 34, bold: true, color: '064E3B' }, paragraph: { spacing: { before: 360, after: 140 }, keepNext: true } },
        heading2: { run: { font: FONT, size: 28, bold: true, color: '065F46' }, paragraph: { spacing: { before: 300, after: 120 }, keepNext: true } },
        heading3: { run: { font: FONT, size: 25, bold: true, color: '065F46' }, paragraph: { spacing: { before: 240, after: 100 }, keepNext: true } },
        heading4: { run: { font: FONT, size: 23, bold: true, color: '1F2A24' }, paragraph: { spacing: { before: 200, after: 80 }, keepNext: true } },
        heading5: { run: { font: FONT, size: 22, bold: true, color: '1F2A24' }, paragraph: { spacing: { before: 160, after: 80 }, keepNext: true } },
      },
    },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      headers: {
        default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: title, font: FONT, size: 16, color: MUTED })] })] }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], font: FONT, size: 16, color: MUTED })],
          })],
        }),
      },
      children: out,
    }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildDocx };
