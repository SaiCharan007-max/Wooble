"""One command to start everything: platform server + IoT simulator, then open the dashboard.

    python run_demo.py            # continue with existing data
    python run_demo.py --fresh    # wipe the database and outbox, start a clean demo
"""
import argparse
import os
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

import requests

ROOT = Path(__file__).parent
URL = "http://127.0.0.1:8000"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fresh", action="store_true", help="delete previous data before starting")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    if args.fresh:
        for f in ROOT.glob("homeward.db*"):
            f.unlink()
        for f in ROOT.glob("hub_outbox.db*"):
            f.unlink()
        print("Starting with a fresh database.")

    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    server = subprocess.Popen([sys.executable, "-m", "homeward.server"], cwd=ROOT, env=env)
    for _ in range(40):
        try:
            requests.get(f"{URL}/api/health", timeout=1)
            break
        except requests.RequestException:
            time.sleep(0.25)
    simulator = subprocess.Popen([sys.executable, "-m", "homeward.simulator"], cwd=ROOT, env=env)
    print(f"\nHomeWard is running -> {URL}   (Ctrl+C to stop)\n")
    if not args.no_browser:
        webbrowser.open(URL)
    try:
        while server.poll() is None and simulator.poll() is None:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        for p in (simulator, server):
            p.terminate()


if __name__ == "__main__":
    main()
