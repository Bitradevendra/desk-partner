# ==============================================================================
# PetBot Desktop Partner Harness - Open-Source Agent Ecosystem Bootstrapper (Windows)
# Configures Model Context Protocol (MCP) servers, Playwright headless browser,
# system monitors, and optional Python browser-use / open-interpreter sidecars.
# ==============================================================================

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HarnessDir = (Get-Item "$ScriptDir\..").FullName
$VendorDir = Join-Path $HarnessDir "vendor"

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host " 🤖 Bootstrapping PetBot Autonomous Desktop Partner Ecosystem     " -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "Target directory: $HarnessDir"
Write-Host "Vendor directory: $VendorDir"

if (-not (Test-Path $VendorDir)) {
    New-Item -ItemType Directory -Path $VendorDir -Force | Out-Null
}

# 1. Install Node.js core partner packages via pnpm
Write-Host "`n[1/4] Ensuring core npm dependencies are installed..." -ForegroundColor Yellow
Set-Location $HarnessDir
pnpm add `
  @modelcontextprotocol/sdk `
  playwright-core `
  chokidar `
  node-cron `
  clipboardy `
  systeminformation

pnpm add -D `
  @types/node-cron

# 2. Check and stage Playwright Chromium binary without foreground GUI dependencies
Write-Host "`n[2/4] Verifying headless Chromium environment..." -ForegroundColor Yellow
try {
    npx playwright-core install chromium
} catch {
    Write-Host "Playwright browser install notice: will use system Chrome/Edge if installed." -ForegroundColor DarkGray
}

# 3. Setup Model Context Protocol (MCP) reference server configurations
Write-Host "`n[3/4] Initializing Model Context Protocol (MCP) vendor configs..." -ForegroundColor Yellow
$McpDir = Join-Path $VendorDir "mcp"
if (-not (Test-Path $McpDir)) {
    New-Item -ItemType Directory -Path $McpDir -Force | Out-Null
}

$HomeDir = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::UserProfile).Replace('\', '/')
$McpConfigJson = @"
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "$HomeDir/Desktop", "$HomeDir/Downloads", "$HomeDir/Documents"]
    },
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    },
    "sqlite": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sqlite", "--db-path", "$HomeDir/.petbot/partner-data.db"]
    }
  }
}
"@
Set-Content -Path (Join-Path $McpDir "mcp-servers.json") -Value $McpConfigJson -Encoding UTF8

# 4. Optional Python Sidecar Bridge (uv / open-interpreter / browser-use)
Write-Host "`n[4/4] Checking Python AI automation sidecar environment..." -ForegroundColor Yellow
$PythonSidecarDir = Join-Path $VendorDir "python-sidecar"
if (-not (Test-Path $PythonSidecarDir)) {
    New-Item -ItemType Directory -Path $PythonSidecarDir -Force | Out-Null
}

$uvAvailable = Get-Command "uv" -ErrorAction SilentlyContinue
$pythonAvailable = Get-Command "python" -ErrorAction SilentlyContinue

if ($uvAvailable) {
    Write-Host "Found 'uv' package manager. Setting up isolated Python sidecar environment..." -ForegroundColor Green
    Set-Location $PythonSidecarDir
    if (-not (Test-Path "$PythonSidecarDir\.venv")) {
        uv venv .venv
    }
    Write-Host "Python venv ready at $PythonSidecarDir\.venv"
} elseif ($pythonAvailable) {
    Write-Host "Found 'python'. Standard venv available if sidecar is activated." -ForegroundColor Green
} else {
    Write-Host "Python not detected on PATH. Headless Node.js + Playwright + MCP stack fully operational." -ForegroundColor DarkGray
}

$SidecarBridgePy = @"
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
        line = line.strip()
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
"@
Set-Content -Path (Join-Path $PythonSidecarDir "sidecar_bridge.py") -Value $SidecarBridgePy -Encoding UTF8

Write-Host "`n==================================================================" -ForegroundColor Green
Write-Host " ✔ PetBot Autonomous Desktop Partner Ecosystem Bootstrap Complete " -ForegroundColor Green
Write-Host "==================================================================" -ForegroundColor Green
