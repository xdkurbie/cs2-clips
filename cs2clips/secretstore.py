"""Local-only secret storage. Windows: DPAPI (CryptProtectData, current user). Else: keyring, or refuse.
Secrets are never logged; use mask() for display."""
from __future__ import annotations
import base64, json, sys
from pathlib import Path

SECRET_KEYS = ("steam_api_key", "steamid64", "auth_code", "last_sharecode")


class SecretStoreUnavailable(RuntimeError):
    pass


def mask(value: str | None) -> str:
    if not value:
        return ""
    return "•" * max(len(value) - 4, 4) + value[-4:] if len(value) > 8 else "•" * len(value)


class DpapiBackend:
    def __init__(self):
        if sys.platform != "win32":
            raise SecretStoreUnavailable("DPAPI is Windows-only")
        import ctypes
        from ctypes import wintypes
        self.c, self.w = ctypes, wintypes

        class BLOB(ctypes.Structure):
            _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]
        self.BLOB = BLOB

    def _call(self, fn, data: bytes) -> bytes:
        c = self.c
        buf = c.create_string_buffer(data, len(data))
        inp = self.BLOB(len(data), c.cast(buf, c.POINTER(c.c_char)))
        out = self.BLOB()
        if not fn(c.byref(inp), None, None, None, None, 0x1, c.byref(out)):  # CRYPTPROTECT_UI_FORBIDDEN
            raise SecretStoreUnavailable("DPAPI call failed")
        try:
            return c.string_at(out.pbData, out.cbData)
        finally:
            c.windll.kernel32.LocalFree(out.pbData)

    def protect(self, data: bytes) -> bytes:
        return self._call(lambda i, d, e, r, p, f, o: self.c.windll.crypt32.CryptProtectData(i, "cs2-clips", e, r, p, f, o), data)

    def unprotect(self, data: bytes) -> bytes:
        return self._call(lambda i, d, e, r, p, f, o: self.c.windll.crypt32.CryptUnprotectData(i, None, e, r, p, f, o), data)


class SecretStore:
    """Stores DPAPI-encrypted blobs in a JSON file; on non-Windows delegates to keyring if installed."""

    def __init__(self, path: Path, backend=None, keyring_mod=None):
        self.path = Path(path)
        self.backend = backend
        self.keyring = keyring_mod
        if self.backend is None and self.keyring is None:
            try:
                self.backend = DpapiBackend()
            except SecretStoreUnavailable:
                try:
                    import keyring
                    self.keyring = keyring
                except ImportError:
                    raise SecretStoreUnavailable(
                        "No secure storage: needs Windows DPAPI or the 'keyring' package. Refusing to store secrets.")

    def _blob(self) -> dict:
        return json.loads(self.path.read_text("utf-8")) if self.path.exists() else {}

    def set(self, key: str, value: str) -> None:
        if key not in SECRET_KEYS:
            raise KeyError(key)
        if self.keyring:
            self.keyring.set_password("cs2-clips", key, value); return
        d = self._blob()
        d[key] = base64.b64encode(self.backend.protect(value.encode())).decode()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(d), "utf-8")

    def get(self, key: str) -> str:
        if self.keyring:
            return self.keyring.get_password("cs2-clips", key) or ""
        v = self._blob().get(key)
        return self.backend.unprotect(base64.b64decode(v)).decode() if v else ""

    def __repr__(self):
        return "<SecretStore (redacted)>"
