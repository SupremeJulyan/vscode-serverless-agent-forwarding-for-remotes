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
  // 原生 .node 模块不能打包（ssh2/ssh2 依赖 cpu-features 的预编译 binding）：
  // 外部化后运行时 require 失败会被依赖自身的 try/catch 兜底到纯 JS 实现。
  external: ['vscode', '*.node'],
  logLevel: 'info'
}).catch(() => process.exit(1));
