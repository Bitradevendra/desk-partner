#!/usr/bin/env python3
"""
Fetch Vendor Libraries for ESP32-S3 Desktop Robot Firmware
Downloads and extracts required open-source C++ libraries:
- h2zero/NimBLE-Arduino (v1.4.2)
- Links2004/arduinoWebSockets (v2.4.1)
- bblanchon/ArduinoJson (v7.0.4)

Compatible with both PlatformIO SCons extra_scripts and standalone execution.
"""

import os
import sys
import shutil
import urllib.request
import zipfile
from pathlib import Path

# Vendor libraries specification
VENDOR_LIBS = [
    {
        "name": "NimBLE-Arduino",
        "version": "1.4.2",
        "url": "https://github.com/h2zero/NimBLE-Arduino/archive/refs/tags/1.4.2.zip",
        "archive_root": "NimBLE-Arduino-1.4.2",
        "dest_dir": "NimBLE-Arduino",
        "header_check": "src/NimBLEDevice.h"
    },
    {
        "name": "arduinoWebSockets",
        "version": "2.4.1",
        "url": "https://github.com/Links2004/arduinoWebSockets/archive/refs/tags/2.4.1.zip",
        "archive_root": "arduinoWebSockets-2.4.1",
        "dest_dir": "arduinoWebSockets",
        "header_check": "src/WebSocketsServer.h"
    },
    {
        "name": "ArduinoJson",
        "version": "7.0.4",
        "url": "https://github.com/bblanchon/ArduinoJson/archive/refs/tags/v7.0.4.zip",
        "archive_root": "ArduinoJson-7.0.4",
        "dest_dir": "ArduinoJson",
        "header_check": "src/ArduinoJson.h"
    }
]

def fetch_and_extract_libs(target_lib_dir: Path, force: bool = False):
    target_lib_dir.mkdir(parents=True, exist_ok=True)
    temp_dir = target_lib_dir / ".cache"
    temp_dir.mkdir(parents=True, exist_ok=True)

    print(f"[VendorLibs] Target directory: {target_lib_dir}")

    for lib in VENDOR_LIBS:
        dest_path = target_lib_dir / lib["dest_dir"]
        header_check_file = dest_path / lib["header_check"]

        if header_check_file.exists() and not force:
            print(f"[VendorLibs] OK: {lib['name']} @ {lib['version']} already present in {dest_path}")
            continue

        print(f"[VendorLibs] Downloading {lib['name']} @ {lib['version']} from {lib['url']}...")
        zip_path = temp_dir / f"{lib['name']}-{lib['version']}.zip"

        try:
            req = urllib.request.Request(
                lib["url"],
                headers={"User-Agent": "Mozilla/5.0 (ESP32-S3 Firmware Build Script)"}
            )
            with urllib.request.urlopen(req) as response, open(zip_path, 'wb') as out_file:
                shutil.copyfileobj(response, out_file)

            print(f"[VendorLibs] Extracting {zip_path.name}...")
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                # Extract to temp subfolder first
                extract_temp = temp_dir / f"extracted_{lib['name']}"
                if extract_temp.exists():
                    shutil.rmtree(extract_temp)
                zip_ref.extractall(extract_temp)

                src_folder = extract_temp / lib["archive_root"]
                if not src_folder.exists():
                    # Fallback if root folder differs
                    subdirs = [d for d in extract_temp.iterdir() if d.is_dir()]
                    if subdirs:
                        src_folder = subdirs[0]

                if dest_path.exists():
                    shutil.rmtree(dest_path)
                shutil.move(str(src_folder), str(dest_path))

            print(f"[VendorLibs] Successfully installed {lib['name']} -> {dest_path}")
        except Exception as e:
            print(f"[VendorLibs] WARNING: Failed to fetch {lib['name']}: {e}")
            print(f"[VendorLibs] PlatformIO lib_deps will resolve it from PlatformIO Registry if online.")
        finally:
            if zip_path.exists():
                try:
                    zip_path.unlink()
                except OSError:
                    pass

    # Cleanup temp
    if temp_dir.exists():
        try:
            shutil.rmtree(temp_dir)
        except OSError:
            pass

def main():
    script_dir = Path(__file__).resolve().parent
    firmware_dir = script_dir.parent
    lib_dir = firmware_dir / "lib"
    force_update = "--force" in sys.argv

    fetch_and_extract_libs(lib_dir, force=force_update)

# SCons / PlatformIO hook
try:
    from SCons.Script import Import
    Import("env")
    print("[PlatformIO Pre-Script] Running fetch_vendor_libs hook...")
    project_dir = env.subst("$PROJECT_DIR")
    firmware_dir = Path(project_dir) if project_dir else (Path(__file__).resolve().parent.parent if "__file__" in globals() else Path.cwd())
    lib_dir = firmware_dir / "lib"
    fetch_and_extract_libs(lib_dir, force=False)
except ImportError:
    if __name__ == "__main__":
        main()
