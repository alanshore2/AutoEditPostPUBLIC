import os
import subprocess
import sys

from runpy import run_path

# Reuse the credential decryption wrapper without ever writing or printing the key.
wrapper = os.path.join(os.path.dirname(__file__), "run-postiz-cover-repair.py")
source = open(wrapper, "r", encoding="utf-8").read()
source = source.replace('subprocess.run(["node", "src/repair-postiz-covers-cli.mjs"]', 'subprocess.run(["node", "src/repair-postiz-starts-cli.mjs"]')
namespace = {"__name__": "__main__", "__file__": wrapper}
exec(compile(source, wrapper, "exec"), namespace)
