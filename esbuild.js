const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const { patchSftpSource } = require('./build/sftp-banner-patch');

const production = process.argv.includes('--production');

// WSL scripts are packaged directly from resources/. Remove copies produced by
// older builds so VSIX packages contain a single authoritative set.
const wslOut = path.join(__dirname, 'dist', 'resources', 'wsl');
fs.rmSync(wslOut, { recursive: true, force: true });

// 构建期补丁：把 NSG 网关 MOTD banner 容忍逻辑注入 ssh2 的 SFTP 版本握手
// （见 build/sftp-banner-patch.js），让 SFTP 子系统可用的网关不再回退 exec/SCP。
const sftpBannerPatch = {
  name: 'safs-sftp-banner-tolerance',
  setup(build) {
    build.onLoad({ filter: /[\\/]node_modules[\\/]ssh2[\\/]lib[\\/]protocol[\\/]SFTP\.js$/ }, async (args) => {
      const contents = await fs.promises.readFile(args.path, 'utf8');
      return { contents: patchSftpSource(contents), loader: 'js' };
    });
  }
};

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
  logLevel: 'info',
  plugins: [sftpBannerPatch]
}).catch(() => process.exit(1));
