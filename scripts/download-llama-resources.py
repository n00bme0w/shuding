#!/usr/bin/env python3
"""Download BGE-M3 and build a local llama-server sidecar."""

from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "resources" / "llama"
TARGET.mkdir(parents=True, exist_ok=True)

MODEL_URL = "https://huggingface.co/CompendiumLabs/bge-m3-gguf/resolve/main/bge-m3-f16.gguf"
SOURCE_URL = "https://codeload.github.com/ggml-org/llama.cpp/tar.gz/refs/heads/master"
MODEL_PATH = TARGET / "bge-m3.gguf"
BINARY_PATH = TARGET / ("llama-server.exe" if sys.platform == "win32" else "llama-server")


def download(url: str, destination: Path) -> None:
    if destination.exists() and destination.stat().st_size > 0:
        print(f"already exists: {destination}")
        return
    temporary = destination.with_suffix(destination.suffix + ".part")
    print(f"downloading: {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "shuding-resource-installer"})
    with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as output:
        total = int(response.headers.get("Content-Length", "0"))
        received = 0
        while True:
            block = response.read(1024 * 1024)
            if not block:
                break
            output.write(block)
            received += len(block)
            if total:
                print(f"\r  {received / total:.1%} ({received / 1024 / 1024:.0f} / {total / 1024 / 1024:.0f} MB)", end="", flush=True)
        print()
    temporary.replace(destination)


def build_server() -> None:
    if BINARY_PATH.exists() and list(TARGET.glob("lib*.so*")):
        print(f"already exists: {BINARY_PATH}")
        return
    with tempfile.TemporaryDirectory(prefix="shuding-llama-") as temporary:
        archive = Path(temporary) / "llama.cpp.tar.gz"
        source_root = Path(temporary) / "source"
        download(SOURCE_URL, archive)
        with tarfile.open(archive, "r:gz") as package:
            package.extractall(Path(temporary), filter="data")
        extracted = next(path for path in Path(temporary).iterdir() if path.is_dir() and path.name.startswith("llama.cpp-"))
        extracted.rename(source_root)
        build = source_root / "build"
        subprocess.run(["cmake", "-S", str(source_root), "-B", str(build), "-DLLAMA_BUILD_SERVER=ON", "-DLLAMA_NATIVE=OFF"], check=True)
        subprocess.run(["cmake", "--build", str(build), "--config", "Release", "-j2"], check=True)
        candidates = list(build.rglob("llama-server")) + list(build.rglob("llama-server.exe"))
        if not candidates:
            raise RuntimeError("llama-server was not produced by the build")
        shutil.copy2(candidates[0], BINARY_PATH)
        for library in (build / "bin").glob("lib*.so*"):
            shutil.copy2(library, TARGET / library.name)
        if sys.platform != "win32":
            BINARY_PATH.chmod(0o755)


if __name__ == "__main__":
    download(MODEL_URL, MODEL_PATH)
    build_server()
    print(f"ready: {MODEL_PATH}")
    print(f"ready: {BINARY_PATH}")
