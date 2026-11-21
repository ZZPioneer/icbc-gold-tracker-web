# -*- coding: utf-8 -*-
"""敏感数据加密工具（Fernet 对称加密）。

- 密钥保存在项目目录的 .secret.key，随文件夹一起走；丢失则已加密数据无法解密。
- 个人数据整包加密后再存入 MySQL，数据库里看到的是密文，满足「非明文存储」。
"""
from __future__ import annotations

import base64
import os
import threading

from cryptography.fernet import Fernet, InvalidToken

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
KEY_FILE = os.path.join(BASE_DIR, ".secret.key")

# 用可重入锁：_get_fernet 持锁后会调用 _load_or_create_key，后者首建密钥时也要拿同一把锁
_lock = threading.RLock()
_fernet: Fernet | None = None


def _load_or_create_key() -> bytes:
    if not os.path.exists(KEY_FILE):
        with _lock:
            if not os.path.exists(KEY_FILE):
                key = Fernet.generate_key()
                tmp = KEY_FILE + ".tmp"
                with open(tmp, "wb") as f:
                    f.write(key)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, KEY_FILE)
                try:
                    os.chmod(KEY_FILE, 0o600)
                except OSError:
                    pass
    with open(KEY_FILE, "rb") as f:
        key = f.read().strip()
    # 兼容误删/损坏：非法 key 直接重建会导致旧数据不可读，因此这里明确报错
    try:
        base64.urlsafe_b64decode(key)
        Fernet(key)
    except Exception as exc:
        raise RuntimeError(f"加密密钥文件损坏（{KEY_FILE}），旧数据将无法解密") from exc
    return key


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        with _lock:
            if _fernet is None:
                _fernet = Fernet(_load_or_create_key())
    return _fernet


def encrypt_text(plain: str) -> str:
    """明文字符串 -> 密文字符串（可安全存入数据库）。"""
    return _get_fernet().encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt_text(cipher: str) -> str:
    """密文字符串 -> 明文字符串；密文损坏时抛出异常，由调用方兜底。"""
    return _get_fernet().decrypt(cipher.encode("ascii")).decode("utf-8")


def encrypt_json(obj) -> str:
    import json
    return encrypt_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))


def decrypt_json(cipher: str, default=None):
    import json
    try:
        return json.loads(decrypt_text(cipher))
    except (InvalidToken, ValueError, UnicodeDecodeError):
        return default
