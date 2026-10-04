"""Download only declared public source, verify identity, keep generated files private."""
from pathlib import Path
import argparse
import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "node_modules" / ".cache" / "intent-continuity-demo"
MANIFEST = json.loads((ROOT / "sources.json").read_text())


def download(url, limit):
    with urllib.request.urlopen(url, timeout=30) as response:
        value = response.read(limit + 1)
    if len(value) > limit:
        raise ValueError("Source exceeds declared download bound")
    return value


def checked(value, digest):
    if hashlib.sha256(value).hexdigest() != digest:
        raise ValueError("Pinned source identity mismatch")
    return value


def prepare():
    source = CACHE / "source"
    source.mkdir(parents=True, exist_ok=True)
    for entry in MANIFEST["files"]:
        if Path(entry["name"]).name != entry["name"]:
            raise ValueError("Invalid source destination")
        destination = source / entry["name"]
        if destination.exists():
            checked(destination.read_bytes(), entry["sha256"])
        else:
            value = checked(download(entry["url"], 2 * 1024 * 1024), entry["sha256"])
            destination.write_bytes(value)

    aodl = MANIFEST["aodl"]
    archive_path = CACHE / "aodl.tar.gz"
    if archive_path.exists():
        archive = checked(archive_path.read_bytes(), aodl["sha256"])
    else:
        archive = checked(download(aodl["url"], 12 * 1024 * 1024), aodl["sha256"])
        archive_path.write_bytes(archive)
    checkout = CACHE / ("aodl-" + aodl["commit"])
    # Recheck cached checkout files against the pinned archive on every run.
    total = 0
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as stream:
        members = stream.getmembers()
        for member in members:
            parts = Path(member.name).parts
            if (member.issym() or member.islnk() or member.isdev()
                    or member.name.startswith("/") or ".." in parts
                    or not parts or parts[0] != checkout.name
                    or not (member.isdir() or member.isfile())):
                raise ValueError("Unsafe archive member")
            total += member.size
            if total > 24 * 1024 * 1024:
                raise ValueError("Expanded source exceeds bound")
        for member in members:
            destination = CACHE / member.name
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            value = stream.extractfile(member).read()
            if destination.exists():
                if destination.read_bytes() != value:
                    raise ValueError("Cached AODL source changed")
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(value)

    version = subprocess.run(
        [sys.executable, "-B", "-m", "aodl_contract.cli", "--version", "--json"],
        cwd=checkout, capture_output=True, text=True, check=True, timeout=10,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    identity = json.loads(version.stdout)
    config = {"python": sys.executable, "sourceDir": str(checkout),
              "validatorRevision": identity["validatorRevision"]}
    # Local paths are generated and ignored, never part of repository artifacts.
    (CACHE / "config.json").write_text(json.dumps(config, indent=2) + "\n")
    print("Pinned source identities verified.")
    return checkout


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--test", action="store_true")
    args = parser.parse_args()
    tree = prepare()
    if args.test:
        subprocess.run(
            [sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests",
             "-p", "test_cli_json.py", "-v"],
            cwd=tree, check=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
