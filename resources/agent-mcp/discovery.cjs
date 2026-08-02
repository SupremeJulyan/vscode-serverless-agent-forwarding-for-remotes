const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const maxRecordAgeMs = 35_000;

function windowsPathToWsl(value) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value.trim());
  if (!match) return value.trim();
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

function discoveryDirectories() {
  const homes = new Set([os.homedir(), process.env.USERPROFILE].filter(Boolean));
  if (process.platform === 'linux' && /microsoft|wsl/i.test(os.release())) {
    try {
      const windowsHome = childProcess.execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', "[Environment]::GetFolderPath('UserProfile')"],
        { encoding: 'utf8', timeout: 2000, windowsHide: true }
      );
      homes.add(windowsPathToWsl(windowsHome));
    } catch {
      // Native WSL-only VS Code installations still publish under the WSL home.
    }
  }
  return [...homes].map((home) => path.join(home, '.serverless-remote-ssh', 'agent-workspaces'));
}

function readRecord(filePath, now = Date.now()) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const updatedAt = Date.parse(value.updatedAt);
    if (value.version !== 1 || value.execution !== 'remote' || !value.mcpUrl
      || !Number.isFinite(updatedAt)) return null;
    if (now - updatedAt > maxRecordAgeMs) return null;
    return { ...value, updatedAtMs: updatedAt, discoveryFile: filePath };
  } catch {
    return null;
  }
}

function allWorkspaces() {
  const now = Date.now();
  const records = [];
  for (const directory of discoveryDirectories()) {
    try {
      for (const name of fs.readdirSync(directory)) {
        if (!name.endsWith('.json')) continue;
        const record = readRecord(path.join(directory, name), now);
        if (record) records.push(record);
      }
    } catch {
      // Missing discovery directories mean no active Serverless Remote window.
    }
  }
  records.sort((left, right) =>
    Number(right.focused) - Number(left.focused) || right.updatedAtMs - left.updatedAtMs
  );
  return records;
}

function activeWorkspace() {
  return allWorkspaces()[0] || null;
}

function workspaceForMount(mountName) {
  return allWorkspaces().find((record) => record.mountName === mountName) || null;
}

module.exports = { activeWorkspace, allWorkspaces, workspaceForMount };
