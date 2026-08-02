#!/usr/bin/env bash
# Shared OpenSSH multiplexing options for ssh-bridge.
set -Eeuo pipefail

bridge_performance_now() {
  local value
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    value="${EPOCHREALTIME/./}"
  else
    value="$(date +%s%6N)"
  fi
  printf -v "$1" '%s' "$value"
}

bridge_performance_log() {
  local label="$1" started_at="$2" finished_at elapsed_us
  bridge_performance_now finished_at
  elapsed_us=$((10#$finished_at - 10#$started_at))
  printf '[性能] %s: %d.%03d ms\n' \
    "$label" "$((elapsed_us / 1000))" "$((elapsed_us % 1000))" >&2
}

ssh_control_prepare() {
  SSH_CONTROL_OPTIONS=()
  [[ "${WSL_VPN_SSH_CONNECTION_REUSE:-1}" != 0 ]] || return 0

  local runtime_root="${XDG_RUNTIME_DIR:-${HOME:?}/.wsl-vpn-ssh}"
  local control_dir="$runtime_root/wsl-vpn-ssh-control-${UID:?}"
  if [[ -L "$control_dir" ]]; then
    printf '错误: SSH 控制连接目录不能是符号链接: %s\n' "$control_dir" >&2
    return 1
  fi
  mkdir -p -- "$control_dir"
  if [[ -L "$control_dir" || "$(stat -c %u -- "$control_dir")" != "$UID" ]]; then
    printf '错误: SSH 控制连接目录不属于当前用户: %s\n' "$control_dir" >&2
    return 1
  fi
  chmod 700 -- "$control_dir"

  SSH_CONTROL_OPTIONS=(
    -o ControlMaster=auto
    -o ControlPersist=10m
    -o "ControlPath=$control_dir/%C"
  )
}

ssh_control_status() {
  local destination="$1" port="$2"
  shift 2
  ((${#SSH_CONTROL_OPTIONS[@]})) || {
    printf 'disabled\n'
    return 0
  }
  if ssh "${SSH_CONTROL_OPTIONS[@]}" "$@" -p "$port" -O check -- "$destination" \
      >/dev/null 2>&1; then
    printf 'reused\n'
  else
    printf 'new\n'
  fi
}

ssh_control_status_label() {
  case "$1" in
    reused) printf '复用已有连接\n' ;;
    disabled) printf '已禁用\n' ;;
    new) printf '新建主连接\n' ;;
    *)
      printf '错误: 未知的 SSH 控制连接状态: %s\n' "$1" >&2
      return 1
      ;;
  esac
}
