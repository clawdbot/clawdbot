import { posixAgentWorkspaceScript, windowsAgentWorkspaceScript } from "./agent-workspace.ts";
import { shellQuote } from "./host-command.ts";
import { psSingleQuote, windowsOpenClawResolver } from "./powershell.ts";
import type { Provider, ProviderAuth } from "./types.ts";

export interface NpmUpdateScriptInput {
  auth: ProviderAuth;
  expectedNeedle: string;
  provider: Provider;
  updateTarget: string;
}

const agentModelTimeoutSeconds = Number(process.env.OPENCLAW_PARALLELS_MODEL_TIMEOUT_S || 300);

export function macosUpdateScript(input: NpmUpdateScriptInput): string {
  return String.raw`set -euo pipefail
export PATH=/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin
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
    entries.pop("openai", None)
allow = plugins.get("allow")
if isinstance(allow, list):
    plugins["allow"] = [item for item in allow if item not in {"feishu", "whatsapp", "openai"}]
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
OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 /opt/homebrew/bin/openclaw update --tag ${shellQuote(input.updateTarget)} --yes --json --no-restart
${posixVersionCheck("/opt/homebrew/bin/openclaw", input.expectedNeedle)}
start_openclaw_gateway
wait_for_gateway
/opt/homebrew/bin/openclaw models set ${shellQuote(input.auth.modelId)}
/opt/homebrew/bin/openclaw config set models.providers.${input.provider}.timeoutSeconds ${agentModelTimeoutSeconds} --strict-json
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
    foreach ($pluginId in @('feishu', 'whatsapp', 'openai')) {
      if ($entries.ContainsKey($pluginId)) { $entries.Remove($pluginId) }
    }
  }
  $allow = $plugins['allow']
  if ($allow -is [array]) {
    $plugins['allow'] = @($allow | Where-Object { $_ -notin @('feishu', 'whatsapp', 'openai') })
  }
  $config | ConvertTo-Json -Depth 100 | Set-Content -Path $configPath -Encoding UTF8
}
function Stop-OpenClawGatewayProcesses {
  Invoke-OpenClaw gateway stop *>&1 | Out-Host
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'openclaw.*gateway' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}
Remove-FuturePluginEntries
Stop-OpenClawGatewayProcesses
$env:OPENCLAW_DISABLE_BUNDLED_PLUGINS = '1'
$updateOutput = Invoke-OpenClaw update --tag ${psSingleQuote(input.updateTarget)} --yes --json --no-restart 2>&1
$updateExit = $LASTEXITCODE
$updateOutput
if ($updateExit -ne 0) {
  $updateText = $updateOutput | Out-String
  $stalePostSwapImport = $updateText -match 'ERR_MODULE_NOT_FOUND' -and $updateText -match 'node_modules\\openclaw\\dist\\[^\\]+-[A-Za-z0-9_-]+\\.js'
  if (-not $stalePostSwapImport) { throw "openclaw update failed with exit code $updateExit" }
  Write-Host "openclaw update returned a stale post-swap module import; continuing to post-update health checks"
}
${windowsVersionCheck(input.expectedNeedle)}
function Wait-OpenClawGateway {
  $deadline = (Get-Date).AddSeconds(180)
  $attempt = 0
  while ((Get-Date) -lt $deadline) {
    Invoke-OpenClaw gateway status --deep --require-rpc --timeout 15000
    if ($LASTEXITCODE -eq 0) { return }
    $attempt += 1
    if ($attempt -eq 4) {
      Invoke-OpenClaw gateway start *>&1 | Out-Host
    }
    Start-Sleep -Seconds 5
  }
  throw "gateway did not become ready after update"
}
Invoke-OpenClaw gateway restart *>&1 | Out-Host
if ($LASTEXITCODE -ne 0) {
  "gateway restart exited with code $LASTEXITCODE; probing readiness before failing" | Out-Host
}
Wait-OpenClawGateway
Invoke-OpenClaw models set ${psSingleQuote(input.auth.modelId)}
Invoke-OpenClaw config set models.providers.${input.provider}.timeoutSeconds ${agentModelTimeoutSeconds} --strict-json
Invoke-OpenClaw config set agents.defaults.skipBootstrap true --strict-json
${windowsAgentWorkspaceScript("Parallels npm update smoke test assistant.")}
Set-Item -Path ('Env:' + ${psSingleQuote(input.auth.apiKeyEnv)}) -Value ${psSingleQuote(input.auth.apiKeyValue)}
Invoke-OpenClaw agent --local --agent main --session-id parallels-npm-update-windows --message 'Reply with exact ASCII text OK only.' --json`;
}

export function linuxUpdateScript(input: NpmUpdateScriptInput): string {
  return String.raw`set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/snap/bin
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
  delete plugins.entries.openai;
}
if (Array.isArray(plugins.allow)) {
  plugins.allow = plugins.allow.filter((id) => id !== "feishu" && id !== "whatsapp" && id !== "openai");
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
OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 openclaw update --tag ${shellQuote(input.updateTarget)} --yes --json --no-restart
${posixVersionCheck("openclaw", input.expectedNeedle)}
start_openclaw_gateway
wait_for_gateway
openclaw models set ${shellQuote(input.auth.modelId)}
openclaw config set models.providers.${input.provider}.timeoutSeconds ${agentModelTimeoutSeconds} --strict-json
openclaw config set agents.defaults.skipBootstrap true --strict-json
${posixAgentWorkspaceScript("Parallels npm update smoke test assistant.")}
${input.auth.apiKeyEnv}=${shellQuote(input.auth.apiKeyValue)} openclaw agent --local --agent main --session-id parallels-npm-update-linux --message 'Reply with exact ASCII text OK only.' --json`;
}

function posixVersionCheck(command: string, expectedNeedle: string): string {
  const quotedNeedle = shellQuote(expectedNeedle);
  if (!expectedNeedle) {
    return `hash -r || true
version_deadline=$((SECONDS + 60))
while true; do
  if version="$(${command} --version 2>&1)"; then
    version_status=0
    printf '%s\\n' "$version"
    break
  else
    version_status=$?
    printf '%s\\n' "$version"
  fi
  if [ "$SECONDS" -ge "$version_deadline" ]; then
    exit "$version_status"
  fi
  sleep 2
done`;
  }
  return `hash -r || true
version_deadline=$((SECONDS + 60))
while true; do
  if version="$(${command} --version 2>&1)"; then
    version_status=0
    printf '%s\\n' "$version"
    case "$version" in *${quotedNeedle}*) break ;; esac
  else
    version_status=$?
    printf '%s\\n' "$version"
  fi
  if [ "$SECONDS" -ge "$version_deadline" ]; then
    if [ "$version_status" -ne 0 ]; then
      exit "$version_status"
    fi
    echo "version mismatch: expected ${expectedNeedle}" >&2
    exit 1
  fi
  sleep 2
done`;
}

function windowsVersionCheck(expectedNeedle: string): string {
  if (!expectedNeedle) {
    return `$versionDeadline = (Get-Date).AddSeconds(60)
while ($true) {
  $version = Invoke-OpenClaw --version
  $version
  if ($LASTEXITCODE -eq 0) { break }
  if ((Get-Date) -ge $versionDeadline) { throw "openclaw --version failed with exit code $LASTEXITCODE" }
  Start-Sleep -Seconds 2
}`;
  }
  const expectedPattern = psSingleQuote(`*${expectedNeedle}*`);
  const mismatch = psSingleQuote(`version mismatch: expected ${expectedNeedle}`);
  return `$versionDeadline = (Get-Date).AddSeconds(60)
while ($true) {
  $version = Invoke-OpenClaw --version
  $version
  if ($LASTEXITCODE -eq 0 -and (($version | Out-String) -like ${expectedPattern})) { break }
  if ((Get-Date) -ge $versionDeadline) {
    if ($LASTEXITCODE -ne 0) { throw "openclaw --version failed with exit code $LASTEXITCODE" }
    throw ${mismatch}
  }
  Start-Sleep -Seconds 2
}`;
}
