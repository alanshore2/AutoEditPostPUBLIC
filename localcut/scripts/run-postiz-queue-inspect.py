import base64
import ctypes
import json
import os
import subprocess
import sys
from ctypes import wintypes
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class DataBlob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_char))]


def unprotect(ciphertext: bytes) -> bytes:
    source_buffer = ctypes.create_string_buffer(ciphertext)
    source = DataBlob(len(ciphertext), ctypes.cast(source_buffer, ctypes.POINTER(ctypes.c_char)))
    target = DataBlob()
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(source), None, None, None, None, 0, ctypes.byref(target)
    ):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        ctypes.windll.kernel32.LocalFree(target.data)


home = Path.home()
config = json.loads((home / ".localcut" / "postiz.json").read_text(encoding="utf-8"))
local_state = json.loads((home / "AppData" / "Roaming" / "LocalCut" / "Local State").read_text(encoding="utf-8"))
wrapped_key = base64.b64decode(local_state["os_crypt"]["encrypted_key"])
if not wrapped_key.startswith(b"DPAPI"):
    raise RuntimeError("Unexpected LocalCut encryption-key format")
master_key = unprotect(wrapped_key[5:])
encrypted = base64.b64decode(config["encryptedKey"])
if not encrypted.startswith(b"v10"):
    raise RuntimeError("Unexpected encrypted Postiz credential format")
postiz_key = AESGCM(master_key).decrypt(encrypted[3:15], encrypted[15:], None).decode("utf-8").strip()
environment = os.environ.copy()
environment["POSTIZ_KEY"] = postiz_key
environment["POSTIZ_API_URL"] = config.get("apiUrl", "https://api.postiz.com/public/v1")
try:
    completed = subprocess.run(["node", "src/inspect-postiz-queue-cli.mjs"], env=environment, check=False)
finally:
    environment.pop("POSTIZ_KEY", None)
    postiz_key = ""
sys.exit(completed.returncode)
