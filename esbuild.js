const esbuild = require('esbuild');

const production = process.argv.includes('--production');

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
