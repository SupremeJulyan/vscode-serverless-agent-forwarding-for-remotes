const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');

// WSL scripts are packaged directly from resources/. Remove copies produced by
// older builds so VSIX packages contain a single authoritative set.
const wslOut = path.join(__dirname, 'dist', 'resources', 'wsl');
fs.rmSync(wslOut, { recursive: true, force: true });

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
