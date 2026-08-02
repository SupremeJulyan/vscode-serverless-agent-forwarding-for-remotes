const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');

// Bundle WSL helper scripts into dist/ so they ship with the extension.
// VS Code loads them through `onDidCloseTerminal` (not require), so they
// stay outside the JS bundle but are packaged alongside it.
const wslSrc = path.join(__dirname, 'resources', 'wsl');
const wslOut = path.join(__dirname, 'dist', 'resources', 'wsl');
fs.mkdirSync(wslOut, { recursive: true });
for (const name of fs.readdirSync(wslSrc)) {
  fs.copyFileSync(path.join(wslSrc, name), path.join(wslOut, name));
}

esbuild.build({
  entryPoints: {
    extension: 'src/extension.ts'
  },
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  outdir: 'dist',
  external: ['vscode'],
  logLevel: 'info'
}).catch(() => process.exit(1));
