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
    if (value.version !== 1 || value.execution !== 'remote' || !value.mcpServerName
      || !Number.isFinite(updatedAt)) return null;
    if (now - updatedAt > maxRecordAgeMs) return null;
    return { ...value, updatedAtMs: updatedAt, discoveryFile: filePath };
  } catch {
    return null;
  }
}

function activeWorkspace() {
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
  return records[0] || null;
}

function workspaceForBinding(binding) {
  if (!binding?.mountName) return null;
  const now = Date.now();
  const records = [];
  for (const directory of discoveryDirectories()) {
    try {
      for (const name of fs.readdirSync(directory)) {
        if (!name.endsWith('.json')) continue;
        const record = readRecord(path.join(directory, name), now);
        if (record?.mountName === binding.mountName) records.push(record);
      }
    } catch {
      // Missing discovery directories mean the bound workspace is offline.
    }
  }
  records.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  return records[0] || null;
}

function bindingPath(sessionId) {
  const dataDirectory = process.env.PLUGIN_DATA
    || path.join(os.homedir(), '.serverless-remote-ssh', 'codex-plugin');
  return path.join(dataDirectory, 'bindings', `${sessionId}.json`);
}

function writeBinding(sessionId, workspace) {
  const filePath = bindingPath(sessionId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({
    version: 1,
    sessionId,
    instanceId: workspace.instanceId,
    workspaceUri: workspace.workspaceUri,
    mountName: workspace.mountName,
    remoteRoot: workspace.remoteRoot,
    mcpServerName: workspace.mcpServerName,
    boundAt: new Date().toISOString()
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function readBinding(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(bindingPath(sessionId), 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { activeWorkspace, readBinding, workspaceForBinding, writeBinding };
