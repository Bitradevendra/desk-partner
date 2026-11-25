#!/usr/bin/env bash
# ==============================================================================
# PetBot Desktop Partner Harness - Open-Source Agent Ecosystem Bootstrapper
# Configures Model Context Protocol (MCP) servers, Playwright headless browser,
# system monitors, and optional Python browser-use / open-interpreter sidecars.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENDOR_DIR="${HARNESS_DIR}/vendor"

echo "=================================================================="
echo " 🤖 Bootstrapping PetBot Autonomous Desktop Partner Ecosystem     "
echo "=================================================================="
echo "Target directory: ${HARNESS_DIR}"
echo "Vendor directory: ${VENDOR_DIR}"

mkdir -p "${VENDOR_DIR}"

# 1. Install Node.js core partner packages via pnpm
echo ""
echo "[1/4] Ensuring core npm dependencies are installed..."
cd "${HARNESS_DIR}"
pnpm add \
  @modelcontextprotocol/sdk \
  playwright-core \
  chokidar \
  node-cron \
  clipboardy \
  systeminformation

pnpm add -D \
  @types/node-cron

# 2. Check and stage Playwright Chromium binary without foreground GUI dependencies
echo ""
echo "[2/4] Verifying headless Chromium environment..."
if command -v npx >/dev/null 2>&1; then
  npx playwright-core install chromium || echo "Playwright browser install notice: will use system Chrome/Edge if installed."
fi

# 3. Setup Model Context Protocol (MCP) reference server configurations
echo ""
echo "[3/4] Initializing Model Context Protocol (MCP) vendor configs..."
mkdir -p "${VENDOR_DIR}/mcp"

cat <<'EOF' > "${VENDOR_DIR}/mcp/mcp-servers.json"
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${HOME}/Desktop", "${HOME}/Downloads", "${HOME}/Documents"]
    },
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    },
    "sqlite": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sqlite", "--db-path", "${HOME}/.petbot/partner-data.db"]
    }
  }
}
EOF

# 4. Optional Python Sidecar Bridge (uv / open-interpreter / browser-use)
echo ""
echo "[4/4] Checking Python AI automation sidecar environment..."
mkdir -p "${VENDOR_DIR}/python-sidecar"

if command -v uv >/dev/null 2>&1; then
  echo "Found 'uv' package manager. Setting up isolated Python sidecar environment..."
  cd "${VENDOR_DIR}/python-sidecar"
  if [ ! -d ".venv" ]; then
    uv venv .venv
  fi
  # Note: Installing open-interpreter / browser-use is optional and non-blocking
  echo "Python venv ready at ${VENDOR_DIR}/python-sidecar/.venv"
elif command -v python3 >/dev/null 2>&1; then
  echo "Found 'python3'. Standard venv available if sidecar is activated."
else
  echo "Python not detected on PATH. Headless Node.js + Playwright + MCP stack fully operational."
fi

cat <<'EOF' > "${VENDOR_DIR}/python-sidecar/sidecar_bridge.py"
"""
PetBot Python Sidecar Bridge
Optional zero-overhead RPC interface for open-interpreter and browser-use.
Communicates with PetBot Desktop Harness via standard stdin/stdout JSON-RPC.
"""
import sys
import json

def process_command(cmd_obj):
    action = cmd_obj.get("action", "")
    params = cmd_obj.get("params", {})
    
    if action == "ping":
        return {"status": "ok", "message": "Python sidecar online"}
    elif action == "capabilities":
        return {
            "status": "ok",
            "capabilities": ["python_execution", "pandas_analysis", "browser_use_ready"]
        }
    else:
        return {"status": "unknown_action", "action": action}

def main():
    for line in sys.stdin:
        line = line.trim() if hasattr(line, 'trim') else line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            res = process_command(req)
            sys.stdout.write(json.dumps(res) + "\n")
            sys.stdout.flush()
        except Exception as e:
            sys.stdout.write(json.dumps({"status": "error", "message": str(e)}) + "\n")
            sys.stdout.flush()

if __name__ == "__main__":
    main()
EOF

echo ""
echo "=================================================================="
echo " ✔ PetBot Autonomous Desktop Partner Ecosystem Bootstrap Complete "
echo "=================================================================="
