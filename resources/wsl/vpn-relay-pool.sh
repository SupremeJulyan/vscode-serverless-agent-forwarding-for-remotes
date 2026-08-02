#!/usr/bin/env bash
# Shared, reference-counted Windows relay pool for the bundled ssh-bridge.
set -Eeuo pipefail

VPN_TOOLKIT_DIR="${VPN_TOOLKIT_DIR:-${BUNDLE_ROOT:-$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")}}"
VPN_POOL_DIR="${XDG_RUNTIME_DIR:-/tmp}/vpn-relay-pool-${UID}"

vpn_secure_pool_dir() {
  local owner expected_owner
  expected_owner="$(id -u)" || return 1
  if [[ -L "$VPN_POOL_DIR" ]]; then
    printf '不安全的中继状态目录（符号链接）: %s\n' "$VPN_POOL_DIR" >&2
    return 1
  fi
  if [[ ! -e "$VPN_POOL_DIR" ]]; then
    mkdir -m 700 -- "$VPN_POOL_DIR" || return 1
  fi
  if [[ ! -d "$VPN_POOL_DIR" || -L "$VPN_POOL_DIR" ]]; then
    printf '中继状态路径不是安全目录: %s\n' "$VPN_POOL_DIR" >&2
    return 1
  fi
  owner="$(stat -c %u -- "$VPN_POOL_DIR")" || return 1
  if [[ "$owner" != "$expected_owner" ]]; then
    printf '中继状态目录不属于当前用户: %s\n' "$VPN_POOL_DIR" >&2
    return 1
  fi
  chmod 700 -- "$VPN_POOL_DIR"
}

vpn_powershell() {
  (cd -- "$VPN_TOOLKIT_DIR" && powershell.exe "$@")
}

vpn_hash() {
  python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:24])' "$1"
}

vpn_process_valid() {
  local pid="$1" port="$2"
  vpn_powershell -NoProfile -Command \
    "\$p=Get-CimInstance Win32_Process -Filter 'ProcessId=$pid' -ErrorAction SilentlyContinue; \$l=Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Where-Object OwningProcess -eq $pid; if(\$p.CommandLine -like '*windows_tcp_relay.py*' -and \$l){'true'}else{'false'}" \
    </dev/null 2>/dev/null | tr -d '\r'
}

vpn_stop_process() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  vpn_powershell -NoProfile -Command \
    "\$p=Get-CimInstance Win32_Process -Filter 'ProcessId=$pid' -ErrorAction SilentlyContinue; if(\$p.CommandLine -like '*windows_tcp_relay.py*'){Stop-Process -Id $pid -Force; Wait-Process -Id $pid -Timeout 5 -ErrorAction SilentlyContinue}" \
    </dev/null >/dev/null 2>&1 || true
}

# Prints: <windows_pid> <local_port> <created|reused>
vpn_relay_acquire() {
  local target_host="$1" target_port="$2" holder="$3"
  local key holder_key state_file lease_dir lock_file
  local relay_pid="" local_port="" saved_host="" saved_port="" relay_status="reused"
  local relay_json relay_win starter_win valid="false"
  local lock_fd

  for command in python3 powershell.exe wslpath flock stat; do
    command -v "$command" >/dev/null 2>&1 \
      || { printf '缺少命令: %s\n' "$command" >&2; return 1; }
  done
  key="$(vpn_hash "$target_host:$target_port")"
  holder_key="$(vpn_hash "$holder")"
  vpn_secure_pool_dir || return 1
  state_file="$VPN_POOL_DIR/$key.state"
  lease_dir="$VPN_POOL_DIR/$key.leases"
  lock_file="$VPN_POOL_DIR/$key.lock"
  exec {lock_fd}>"$lock_file"
  chmod 600 -- "$lock_file"
  flock "$lock_fd"

  if [[ -r "$state_file" ]]; then
    {
      IFS= read -r relay_pid || true
      IFS= read -r local_port || true
      IFS= read -r saved_host || true
      IFS= read -r saved_port || true
    } <"$state_file"
    if [[ "$relay_pid" =~ ^[0-9]+$ && "$local_port" =~ ^[0-9]+$ \
      && "$saved_host" == "$target_host" && "$saved_port" == "$target_port" ]]; then
      valid="$(vpn_process_valid "$relay_pid" "$local_port")"
    fi
  fi

  if [[ "$valid" != true ]]; then
    [[ "$relay_pid" =~ ^[0-9]+$ ]] && vpn_stop_process "$relay_pid"
    rm -f -- "$state_file"
    rm -rf -- "$lease_dir"
    relay_win="$(wslpath -w "$VPN_TOOLKIT_DIR/windows_tcp_relay.py")"
    starter_win="$(wslpath -w "$VPN_TOOLKIT_DIR/start-vpn-relay.ps1")"
    relay_json="$({
      vpn_powershell -NoProfile -ExecutionPolicy Bypass -File "$starter_win" \
        -RelayScript "$relay_win" \
        -TargetHost "$target_host" \
        -TargetPort "$target_port" \
        -IdleExitSeconds 30 </dev/null
    } | tr -d '\r')" || return 1
    read -r relay_pid local_port < <(
      python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["pid"], d["port"])' \
        <<<"$relay_json"
    )
    printf '%s\n%s\n%s\n%s\n' \
      "$relay_pid" "$local_port" "$target_host" "$target_port" >"$state_file"
    chmod 600 -- "$state_file"
    relay_status="created"
  fi

  mkdir -m 700 -p -- "$lease_dir"
  chmod 700 -- "$lease_dir"
  printf '%s\n' "$holder" >"$lease_dir/$holder_key"
  chmod 600 -- "$lease_dir/$holder_key"
  printf '%s %s %s\n' "$relay_pid" "$local_port" "$relay_status"
  flock -u "$lock_fd"
  exec {lock_fd}>&-
}

vpn_relay_release() {
  local target_host="$1" target_port="$2" holder="$3"
  local key holder_key state_file lease_dir lock_file relay_pid="" lock_fd
  [[ -e "$VPN_POOL_DIR" || -L "$VPN_POOL_DIR" ]] || return 0
  vpn_secure_pool_dir || return 1
  key="$(vpn_hash "$target_host:$target_port")"
  holder_key="$(vpn_hash "$holder")"
  state_file="$VPN_POOL_DIR/$key.state"
  lease_dir="$VPN_POOL_DIR/$key.leases"
  lock_file="$VPN_POOL_DIR/$key.lock"
  [[ -e "$state_file" || -d "$lease_dir" ]] || return 0
  exec {lock_fd}>"$lock_file"
  chmod 600 -- "$lock_file"
  flock "$lock_fd"
  rm -f -- "$lease_dir/$holder_key"
  if [[ ! -d "$lease_dir" ]] || ! find "$lease_dir" -mindepth 1 -maxdepth 1 -type f -print -quit | grep -q .; then
    [[ -r "$state_file" ]] && IFS= read -r relay_pid <"$state_file" || true
    vpn_stop_process "$relay_pid"
    rm -f -- "$state_file"
    rmdir "$lease_dir" 2>/dev/null || true
  fi
  flock -u "$lock_fd"
  exec {lock_fd}>&-
}
