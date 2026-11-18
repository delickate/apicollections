'use strict';

// Launches Electron with ELECTRON_RUN_AS_NODE removed: some hosts (e.g. VS Code
// extensions) set it, which would otherwise make Electron run as plain Node and
// never open a window.
//
//   node scripts/start.js                 run the app (.)
//   node scripts/start.js --dev           run the app with DevTools
//   node scripts/start.js --run=file.js   run another Electron main script
const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');

const root = path.join(__dirname, '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);
const runArg = args.find((arg) => arg.startsWith('--run='));
const target = runArg ? path.resolve(root, runArg.slice('--run='.length)) : '.';
const passthrough = args.filter((arg) => arg !== runArg);

const child = spawn(electron, [target, ...passthrough], { stdio: 'inherit', env, cwd: root });
child.on('exit', (code) => process.exit(code ?? 0));
