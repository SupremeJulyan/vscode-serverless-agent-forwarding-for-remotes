#!/usr/bin/env python3
"""Decrypt passwords stored in bridge JSON configuration (bundled version)."""

import argparse
import base64
import binascii
import getpass
import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile


PREFIX = "enc:v1:"
ENV_NAME = "WSL_VPN_MASTER_PASSWORD"
CACHE_TTL_NAME = "WSL_VPN_PASSWORD_CACHE_TTL"
DEFAULT_CACHE_TTL = 8 * 60 * 60


def cache_path():
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    if not os.path.isdir(runtime) or os.stat(runtime).st_uid != os.getuid():
        runtime = os.path.join(tempfile.gettempdir(), f"wsl-vpn-ssh-{os.getuid()}")
        os.makedirs(runtime, mode=0o700, exist_ok=True)
        if os.stat(runtime).st_uid != os.getuid():
            raise SystemExit("口令缓存目录不属于当前用户")
        os.chmod(runtime, 0o700)
    return os.path.join(runtime, "wsl-vpn-ssh-master-password")


def cached_password():
    path = cache_path()
    try:
        stat = os.stat(path)
        ttl = int(os.environ.get(CACHE_TTL_NAME, DEFAULT_CACHE_TTL))
        if stat.st_uid != os.getuid() or stat.st_mode & 0o077 or ttl <= 0:
            return None
        if __import__("time").time() - stat.st_mtime > ttl:
            os.unlink(path)
            return None
        with open(path, encoding="utf-8") as stream:
            return stream.read()
    except (FileNotFoundError, ValueError):
        return None


def cache_password(value):
    path = cache_path()
    directory = os.path.dirname(path)
    fd, temporary = tempfile.mkstemp(prefix=".master-", dir=directory)
    try:
        os.write(fd, value.encode())
        os.fsync(fd)
        os.close(fd)
        fd = -1
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if fd >= 0:
            os.close(fd)
        if os.path.exists(temporary):
            os.unlink(temporary)


def clear_cached_password():
    try:
        os.unlink(cache_path())
    except FileNotFoundError:
        pass


def master_password():
    value = os.environ.get(ENV_NAME)
    if value is not None:
        if not value:
            raise SystemExit(f"{ENV_NAME} 不能为空")
        return value
    value = cached_password()
    if value:
        return value
    if not sys.stdin.isatty() and not os.path.exists("/dev/tty"):
        raise SystemExit(f"无法交互读取加密口令；请设置 {ENV_NAME}")
    value = getpass.getpass("请输入配置加密口令: ")
    if not value:
        raise SystemExit("加密口令不能为空")
    cache_password(value)
    return value


def mac_key(password, salt):
    return hashlib.pbkdf2_hmac(
        "sha256", b"wsl-vpn-hmac\0" + password.encode(), salt, 600_000, 32
    )


def crypt(data, password, decrypting=False):
    read_fd, write_fd = os.pipe()
    try:
        os.write(write_fd, password.encode() + b"\n")
        os.close(write_fd)
        write_fd = -1
        command = ["openssl", "enc"]
        if decrypting:
            command.append("-d")
        command.extend(["-aes-256-cbc", "-pbkdf2", "-iter", "600000",
                        "-pass", f"fd:{read_fd}"])
        result = subprocess.run(
            command, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=False, pass_fds=(read_fd,),
        )
    except FileNotFoundError:
        raise SystemExit("缺少命令 'openssl'，无法处理加密密码") from None
    finally:
        os.close(read_fd)
        if write_fd >= 0:
            os.close(write_fd)
    if result.returncode:
        raise ValueError("OpenSSL 加解密失败")
    return result.stdout


def decrypt(value, password):
    try:
        raw = base64.urlsafe_b64decode(value[len(PREFIX):].encode())
        ciphertext, tag = raw[:-32], raw[-32:]
        if len(ciphertext) < 32 or not ciphertext.startswith(b"Salted__"):
            raise ValueError
        key = mac_key(password, ciphertext[8:16])
        expected = hmac.new(key, ciphertext, hashlib.sha256).digest()
        if not hmac.compare_digest(tag, expected):
            raise ValueError
        return crypt(ciphertext, password, decrypting=True).decode()
    except (binascii.Error, ValueError, UnicodeDecodeError):
        raise SystemExit("配置密码解密失败：加密口令错误或密文已损坏") from None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("config")
    parser.add_argument("collection", choices=("hosts",))
    parser.add_argument("name")
    args = parser.parse_args()
    try:
        with open(args.config, encoding="utf-8") as stream:
            data = json.load(stream)
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"配置读取失败: {error}")

    entries = data.get(args.collection, []) if isinstance(data, dict) else data
    if not isinstance(entries, list):
        raise SystemExit(f"{args.collection} 必须是数组")
    entry = next((item for item in entries if isinstance(item, dict)
                  and str(item.get("name", "")) == args.name), None)
    if entry is None:
        raise SystemExit(f"未找到名为 '{args.name}' 的配置")
    value = str(entry.get("password") or "")
    if not value:
        return
    if value.startswith(PREFIX):
        password = master_password()
        try:
            plain = decrypt(value, password)
        except SystemExit:
            if os.environ.get(ENV_NAME) is not None:
                raise
            clear_cached_password()
            plain = decrypt(value, master_password())
        sys.stdout.write(plain)


if __name__ == "__main__":
    main()
