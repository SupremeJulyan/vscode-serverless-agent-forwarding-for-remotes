import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { defaultHighRiskCommandPatterns } from '../src/high-risk-commands';

async function main(): Promise<void> {
  const manifestPath = path.resolve(__dirname, '..', 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    contributes?: { configuration?: { properties?: Record<string, { default?: unknown }> } };
  };
  const setting = manifest.contributes?.configuration?.properties?.[
    'safs.highRiskCommandPatterns'
  ];
  if (!setting) throw new Error('package.json does not declare safs.highRiskCommandPatterns');

  const synchronized = JSON.stringify(setting.default)
    === JSON.stringify(defaultHighRiskCommandPatterns);
  if (process.argv.includes('--check')) {
    if (!synchronized) {
      throw new Error(
        'package.json high-risk defaults are stale; run npm run sync-manifest-defaults'
      );
    }
  } else if (!synchronized) {
    setting.default = [...defaultHighRiskCommandPatterns];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
}

void main();
