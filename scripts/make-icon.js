'use strict';

/*
 * Renders assets/logo.svg into the icons electron-builder needs:
 *   build/icon.ico  (16–256 px, for the Windows app and installer)
 *   build/icon.png  (512 px, fallback for other platforms)
 *
 * Run through Electron (it uses nativeImage), not plain Node:
 *   npm run make-icon
 */

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const buildDir = path.join(root, 'build');

/** Packs PNG-encoded images into a single .ico file (Vista+ PNG entries). */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  const datas = [];
  let offset = 6 + entries.length;

  images.forEach((image, index) => {
    const entry = entries.subarray(index * 16, index * 16 + 16);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0); // width (0 => 256)
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1); // height
    entry.writeUInt8(0, 2); // palette colours
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(image.buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.buffer.length;
    datas.push(image.buffer);
  });

  return Buffer.concat([header, entries, ...datas]);
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(buildDir, { recursive: true });
    const svg = fs.readFileSync(path.join(root, 'assets', 'logo.svg'), 'utf8');

    // Render the SVG at high resolution in an offscreen window.
    const win = new BrowserWindow({
      width: 512,
      height: 512,
      show: false,
      frame: false,
      transparent: true,
      useContentSize: true,
      webPreferences: { offscreen: true },
    });
    const page = `<!doctype html><html><body style="margin:0;background:transparent">`
      + `<img style="width:512px;height:512px;display:block" `
      + `src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`;
    await win.loadURL('data:text/html,' + encodeURIComponent(page));
    await new Promise((resolve) => setTimeout(resolve, 700));

    const master = await win.capturePage({ x: 0, y: 0, width: 512, height: 512 });

    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const images = sizes.map((size) => ({
      size,
      buffer: master.resize({ width: size, height: size, quality: 'best' }).toPNG(),
    }));

    fs.writeFileSync(path.join(buildDir, 'icon.ico'), buildIco(images));
    fs.writeFileSync(path.join(buildDir, 'icon.png'), master.resize({ width: 512, height: 512, quality: 'best' }).toPNG());

    console.log('Wrote build/icon.ico (' + sizes.join(', ') + ' px) and build/icon.png (512 px).');
    app.exit(0);
  } catch (error) {
    console.error('Icon generation failed:', error);
    app.exit(1);
  }
});
