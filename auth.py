# -*- coding: utf-8 -*-
"""登录认证：PBKDF2 加盐哈希 + 签名会话 Cookie。

密码绝不明文存储：库里只保存 pbkdf2_sha256 迭代值、盐和哈希。
会话使用 HMAC 签名 token，密钥取自 .secret.key（与加密密钥同源，随项目走）。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import time

from crypto_util import _load_or_create_key

COOKIE_NAME = "gold_session"
SESSION_TTL = 7 * 24 * 3600  # 7 天
_ITERATIONS = 210_000


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        _ITERATIONS,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(dk).decode("ascii"),
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        algo, iters, salt_b64, hash_b64 = encoded.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iters))
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def _signing_key() -> bytes:
    # 从 32 字节 Fernet key 派生一个稳定的 HMAC 密钥
    return hashlib.sha256(b"session|" + _load_or_create_key()).digest()


def make_session(user_id: int) -> str:
    payload = "{}.{}".format(int(user_id), int(time.time()) + SESSION_TTL)
    sig = hmac.new(_signing_key(), payload.encode("ascii"), hashlib.sha256).hexdigest()
    return payload + "." + sig


def parse_session(token: str) -> int | None:
    """校验签名与有效期，返回 user_id；无效返回 None。"""
    try:
        uid, exp, sig = token.split(".", 2)
        if int(exp) < int(time.time()):
            return None
        payload = uid + "." + exp
        expected = hmac.new(_signing_key(), payload.encode("ascii"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        return int(uid)
    except (ValueError, TypeError, AttributeError):
        return None


def cookie_header(token: str, max_age: int = SESSION_TTL) -> str:
    return ("{}={}; Path=/; Max-Age={}; HttpOnly; SameSite=Lax".format(
        COOKIE_NAME, token, max_age))


def clear_cookie_header() -> str:
    return "{}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax".format(COOKIE_NAME)


def token_from_cookie_header(cookie: str | None) -> str | None:
    if not cookie:
        return None
    for part in cookie.split(";"):
        key, _, value = part.strip().partition("=")
        if key == COOKIE_NAME:
            return value
    return None
