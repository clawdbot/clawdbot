import { posixAgentWorkspaceScript, windowsAgentWorkspaceScript } from "./agent-workspace.ts";
import { shellQuote } from "./host-command.ts";
import { psSingleQuote, windowsOpenClawResolver } from "./powershell.ts";
import type { ProviderAuth } from "./types.ts";

export interface NpmUpdateScriptInput {
  auth: ProviderAuth;
  expectedNeedle: string;
  updateTarget: string;
}

export function macosUpdateScript(input: NpmUpdateScriptInput): string {
  return String.raw`set -euo pipefail
scrub_future_plugin_entries() {
  python3 - <<'PY'
import json
from pathlib import Path
path = Path.home() / ".openclaw" / "openclaw.json"
if not path.exists():
    raise SystemExit(0)
try:
    config = json.loads(path.read_text())
except Exception:
    raise SystemExit(0)
plugins = config.get("plugins")
if not isinstance(plugins, dict):
    raise SystemExit(0)
entries = plugins.get("entries")
if isinstance(entries, dict):
    entries.pop("feishu", None)
    entries.pop("whatsapp", None)
allow = plugins.get("allow")
if isinstance(allow, list):
    plugins["allow"] = [item for item in allow if item not in {"feishu", "whatsapp"}]
path.write_text(json.dumps(config, indent=2) + "\n")
PY
}
stop_openclaw_gateway_processes() {
  OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 /opt/homebrew/bin/openclaw gateway stop || true
  pkill -f 'openclaw.*gateway' >/dev/null 2>&1 || true
}
start_openclaw_gateway() {
  if /opt/homebrew/bin/openclaw gateway restart; then
    return
  fi
  pkill -f 'openclaw.*gateway' >/dev/null 2>&1 || true
  rm -f /tmp/openclaw-parallels-macos-gateway.log
  nohup env OPENCLAW_HOME="$HOME" OPENCLAW_STATE_DIR="$HOME/.openclaw" OPENCLAW_CONFIG_PATH="$HOME/.openclaw/openclaw.json" ${input.auth.apiKeyEnv}=${shellQuote(
    input.auth.apiKeyValue,
  )} /opt/homebrew/bin/openclaw gateway run --bind loopback --port 18789 --force >/tmp/openclaw-parallels-macos-gateway.log 2>&1 </dev/null &
}
wait_for_gateway() {
  deadline=$((SECONDS + 240))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if /opt/homebrew/bin/openclaw gateway status --deep --require-rpc --timeout 15000; then
      return
    fi
    sleep 2
  done
  cat /tmp/openclaw-parallels-macos-gateway.log >&2 || true
  echo "gateway did not become ready after update" >&2
  exit 1
}
scrub_future_plugin_entries
stop_openclaw_gateway_processes
OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 /opt/homebrew/bin/openclaw update --tag ${shellQuote(input.updateTarget)} --yes --json
${posixVersionCheck("/opt/homebrew/bin/openclaw", input.expectedNeedle)}
start_openclaw_gateway
wait_for_gateway
/opt/homebrew/bin/openclaw models set ${shellQuote(input.auth.modelId)}
/opt/homebrew/bin/openclaw config set agents.defaults.skipBootstrap true --strict-json
${posixAgentWorkspaceScript("Parallels npm update smoke test assistant.")}
${input.auth.apiKeyEnv}=${shellQuote(input.auth.apiKeyValue)} /opt/homebrew/bin/openclaw agent --local --agent main --session-id parallels-npm-update-macos --message 'Reply with exact ASCII text OK only.' --json`;
}

export function windowsUpdateScript(input: NpmUpdateScriptInput): string {
  return `$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
${windowsOpenClawResolver}
function Remove-FuturePluginEntries {
  $configPath = Join-Path $env:USERPROFILE '.openclaw\\openclaw.json'
  if (-not (Test-Path $configPath)) { return }
  try { $config = Get-Content $configPath -Raw | ConvertFrom-Json -AsHashtable } catch { return }
  $plugins = $config['plugins']
  if (-not ($plugins -is [hashtable])) { return }
  $entries = $plugins['entries']
  if ($entries -is [hashtable]) {
    foreach ($pluginId in @('feishu', 'whatsapp')) {
      if ($entries.ContainsKey($pluginId)) { $entries.Remove($pluginId) }
    }
  }
  $allow = $plugins['allow']
  if ($allow -is [array]) {
    $plugins['allow'] = @($allow | Where-Object { $_ -notin @('feishu', 'whatsapp') })
  }
  $config | ConvertTo-Json -Depth 100 | Set-Content -Path $configPath -Encoding UTF8
}
function Stop-OpenClawGatewayProcesses {
  Invoke-OpenClaw gateway stop *>&1 | Out-Host
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'openclaw.*gateway' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
Remove-FuturePluginEntries
Stop-OpenClawGatewayProcesses
$env:OPENCLAW_DISABLE_BUNDLED_PLUGINS = '1'
Invoke-OpenClaw update --tag ${psSingleQuote(input.updateTarget)} --yes --json
if ($LASTEXITCODE -ne 0) { throw "openclaw update failed with exit code $LASTEXITCODE" }
$version = Invoke-OpenClaw --version
$version
${windowsVersionCheck(input.expectedNeedle)}
Invoke-OpenClaw gateway restart
Invoke-OpenClaw gateway status --deep --require-rpc
Invoke-OpenClaw models set ${psSingleQuote(input.auth.modelId)}
Invoke-OpenClaw config set agents.defaults.skipBootstrap true --strict-json
${windowsAgentWorkspaceScript("Parallels npm update smoke test assistant.")}
Set-Item -Path ('Env:' + ${psSingleQuote(input.auth.apiKeyEnv)}) -Value ${psSingleQuote(input.auth.apiKeyValue)}
Invoke-OpenClaw agent --local --agent main --session-id parallels-npm-update-windows --message 'Reply with exact ASCII text OK only.' --json`;
}

export function linuxUpdateScript(input: NpmUpdateScriptInput): string {
  return String.raw`set -euo pipefail
scrub_future_plugin_entries() {
  node - <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const configPath = path.join(process.env.HOME || "/root", ".openclaw", "openclaw.json");
if (!fs.existsSync(configPath)) process.exit(0);
let config;
try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { process.exit(0); }
const plugins = config.plugins;
if (!plugins || typeof plugins !== "object") process.exit(0);
if (plugins.entries && typeof plugins.entries === "object") {
  delete plugins.entries.feishu;
  delete plugins.entries.whatsapp;
}
if (Array.isArray(plugins.allow)) {
  plugins.allow = plugins.allow.filter((id) => id !== "feishu" && id !== "whatsapp");
}
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
JS
}
stop_openclaw_gateway_processes() {
  OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 openclaw gateway stop || true
  pkill -f 'openclaw.*gateway' >/dev/null 2>&1 || true
}
start_openclaw_gateway() {
  pkill -f "openclaw gateway run" >/dev/null 2>&1 || true
  rm -f /tmp/openclaw-parallels-linux-gateway.log
  setsid sh -lc ${shellQuote(
    `exec env OPENCLAW_HOME=/root OPENCLAW_STATE_DIR=/root/.openclaw OPENCLAW_CONFIG_PATH=/root/.openclaw/openclaw.json OPENCLAW_DISABLE_BONJOUR=1 ${input.auth.apiKeyEnv}=${shellQuote(
      input.auth.apiKeyValue,
    )} openclaw gateway run --bind loopback --port 18789 --force >/tmp/openclaw-parallels-linux-gateway.log 2>&1`,
  )} >/dev/null 2>&1 < /dev/null &
}
wait_for_gateway() {
  deadline=$((SECONDS + 240))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if openclaw gateway status --deep --require-rpc --timeout 15000; then
      return
    fi
    sleep 2
  done
  cat /tmp/openclaw-parallels-linux-gateway.log >&2 || true
  echo "gateway did not become ready after update" >&2
  exit 1
}
scrub_future_plugin_entries
stop_openclaw_gateway_processes
OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 openclaw update --tag ${shellQuote(input.updateTarget)} --yes --json
${posixVersionCheck("openclaw", input.expectedNeedle)}
start_openclaw_gateway
wait_for_gateway
openclaw models set ${shellQuote(input.auth.modelId)}
openclaw config set agents.defaults.skipBootstrap true --strict-json
${posixAgentWorkspaceScript("Parallels npm update smoke test assistant.")}
${input.auth.apiKeyEnv}=${shellQuote(input.auth.apiKeyValue)} openclaw agent --local --agent main --session-id parallels-npm-update-linux --message 'Reply with exact ASCII text OK only.' --json`;
}

function posixVersionCheck(command: string, expectedNeedle: string): string {
  if (!expectedNeedle) {
    return `${command} --version`;
  }
  return `version="$(${command} --version)"; printf '%s\\n' "$version"; case "$version" in *${shellQuote(expectedNeedle)}*) ;; *) echo "version mismatch: expected ${expectedNeedle}" >&2; exit 1 ;; esac`;
}

function windowsVersionCheck(expectedNeedle: string): string {
  if (!expectedNeedle) {
    return "";
  }
  return `if (($version | Out-String) -notlike ${psSingleQuote(`*${expectedNeedle}*`)}) { throw ${psSingleQuote(`version mismatch: expected ${expectedNeedle}`)} }`;
}
