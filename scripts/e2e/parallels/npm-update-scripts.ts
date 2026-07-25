// Npm Update Scripts script supports OpenClaw repository automation.
import { posixAgentWorkspaceScript, windowsAgentWorkspaceScript } from "./agent-workspace.ts";
import { shellQuote } from "./host-command.ts";
import {
  posixCodexPlatformPackageRepairFunction,
  posixProviderOnlyPluginIsolationScript,
  windowsCodexPlatformPackageRepairFunction,
} from "./plugin-isolation.ts";
import {
  psSingleQuote,
  windowsAgentTurnConfigPatchScript,
  windowsOpenClawResolver,
  windowsScopedEnvFunction,
} from "./powershell.ts";
import {
  modelProviderConfigBatchJson,
  resolveParallelsModelTimeoutSeconds,
} from "./provider-auth.ts";
import type { Platform, ProviderAuth } from "./types.ts";

interface NpmUpdateScriptInput {
  auth: ProviderAuth;
  expectedNeedle: string;
  npmRegistry?: string;
  updateTarget: string;
}

const windowsStalePostSwapImportRegex = String.raw`node_modules\\openclaw\\dist\\[^\\]+-[A-Za-z0-9_-]+\.js`;
const macosGuestPath =
  "/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/usr/local/bin:/usr/local/sbin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
const macosOpenClawCommand = '"$OPENCLAW_BIN"';

function posixNpmRegistryEnv(registry: string | undefined): string {
  if (!registry) {
    return "";
  }
  const quoted = shellQuote(registry);
  return `NPM_CONFIG_REGISTRY=${quoted} npm_config_registry=${quoted} `;
}

function posixModelProviderConfigCommands(
  command: string,
  modelId: string,
  platform: Platform,
): string {
  const batchJson = modelProviderConfigBatchJson(modelId, platform);
  if (!batchJson) {
    return "";
  }
  return `provider_config_batch="$(mktemp)"
cat >"$provider_config_batch" <<'JSON'
${batchJson}
JSON
set +e
${command} config set --batch-file "$provider_config_batch" --strict-json
provider_config_exit=$?
set -e
rm -f "$provider_config_batch"
if [ "$provider_config_exit" -ne 0 ]; then exit "$provider_config_exit"; fi`;
}

function posixPrintLogTailFunction(): string {
  return `print_log_tail() {
  log_file="$1"
  max_bytes="\${OPENCLAW_PARALLELS_NPM_UPDATE_LOG_TAIL_BYTES:-262144}"
  case "$max_bytes" in
    ''|*[!0-9]*) max_bytes=262144 ;;
    *) [ "$max_bytes" -gt 0 ] || max_bytes=262144 ;;
  esac
  [ -f "$log_file" ] || return 0
  log_bytes="$(wc -c <"$log_file" 2>/dev/null || echo 0)"
  log_bytes="\${log_bytes//[[:space:]]/}"
  case "$log_bytes" in
    ''|*[!0-9]*) log_bytes=0 ;;
  esac
  if [ "$log_bytes" -gt "$max_bytes" ]; then
    echo "--- $log_file truncated: showing last $max_bytes of $log_bytes bytes ---"
  fi
  tail -c "$max_bytes" "$log_file" 2>/dev/null || true
}`;
}

function posixAssertAgentOkScript(
  command: string,
  input: NpmUpdateScriptInput,
  platform: Extract<Platform, "linux" | "macos">,
  sessionId: string,
) {
  return `${posixProviderOnlyPluginIsolationScript({
    fallbackPluginId: input.auth.modelId.split("/", 1)[0] || "openai",
    modelId: input.auth.modelId,
  })}
${posixCodexPlatformPackageRepairFunction()}
agent_ok=false
for attempt in 1 2; do
  session_id=${shellQuote(sessionId)}
  if [ "$attempt" -gt 1 ]; then session_id=${shellQuote(`${sessionId}-retry`)}"-$attempt"; fi
  rm -f "$HOME/.openclaw/agents/main/sessions/$session_id.jsonl"
  output_file="$(mktemp)"
  set +e
  OPENCLAW_ALLOW_ROOT="\${OPENCLAW_ALLOW_ROOT:-}" ${input.auth.apiKeyEnv}=${shellQuote(input.auth.apiKeyValue)} ${command} agent --local --agent main --session-id "$session_id" --message 'Reply with exact ASCII text OK only.' --thinking off --timeout ${resolveParallelsModelTimeoutSeconds(platform)} --json >"$output_file" 2>&1
  rc=$?
  set -e
  print_log_tail "$output_file"
  if [ "$rc" -ne 0 ]; then
    if [ "$attempt" -lt 2 ] && repair_missing_codex_platform_package "$output_file"; then
      rm -f "$output_file"
      echo "agent turn attempt $attempt hit a missing Codex platform package; retrying"
      continue
    fi
    rm -f "$output_file"
    exit "$rc"
  fi
  if grep -Eq '"finalAssistant(Raw|Visible)Text"[[:space:]]*:[[:space:]]*"OK"' "$output_file"; then
    agent_ok=true
    rm -f "$output_file"
    break
  fi
  rm -f "$output_file"
  if [ "$attempt" -lt 2 ]; then
    echo "agent turn attempt $attempt finished without OK response; retrying"
    sleep 3
  fi
done
if [ "$agent_ok" != true ]; then
  echo "openclaw agent finished without OK response" >&2
  exit 1
fi`;
}

function windowsUpdateWithBundledPluginsDisabled(input: NpmUpdateScriptInput): string {
  const registryEntry = input.npmRegistry
    ? `; NPM_CONFIG_REGISTRY = ${psSingleQuote(input.npmRegistry)}`
    : "";
  return `$script:OpenClawUpdateExit = 0
$updateOutput = Invoke-WithScopedEnv @{ OPENCLAW_DISABLE_BUNDLED_PLUGINS = '1'; OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS = '1'${registryEntry} } {
  Invoke-OpenClaw update --tag ${psSingleQuote(input.updateTarget)} --yes --json --no-restart 2>&1
  $script:OpenClawUpdateExit = $LASTEXITCODE
}
$updateExit = $script:OpenClawUpdateExit
$updateOutput`;
}

function windowsGatewayReadyScript(): string {
  return `function Wait-OpenClawGateway {
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
Wait-OpenClawGateway`;
}

function windowsAssertAgentOkScript(input: NpmUpdateScriptInput): string {
  return `${windowsAgentTurnConfigPatchScript(input.auth.modelId)}
${windowsCodexPlatformPackageRepairFunction()}
$sessionPath = Join-Path $env:USERPROFILE '.openclaw\\agents\\main\\sessions\\parallels-npm-update-windows.jsonl'
Remove-Item $sessionPath -Force -ErrorAction SilentlyContinue
${windowsAgentWorkspaceScript("Parallels npm update smoke test assistant.")}
Set-Item -Path ('Env:' + ${psSingleQuote(input.auth.apiKeyEnv)}) -Value ${psSingleQuote(input.auth.apiKeyValue)}
$agentOk = $false
for ($attempt = 1; $attempt -le 2; $attempt++) {
  $sessionId = if ($attempt -eq 1) { 'parallels-npm-update-windows' } else { "parallels-npm-update-windows-retry-$attempt" }
  $sessionsDir = Join-Path $env:USERPROFILE '.openclaw\\agents\\main\\sessions'
  $sessionPath = Join-Path $sessionsDir "$sessionId.jsonl"
  Remove-Item $sessionPath -Force -ErrorAction SilentlyContinue
  $output = Invoke-OpenClaw agent --local --agent main --session-id $sessionId --model ${psSingleQuote(input.auth.modelId)} --message 'Reply with exact ASCII text OK only.' --thinking off --timeout ${resolveParallelsModelTimeoutSeconds("windows")} --json 2>&1
  $agentExitCode = $LASTEXITCODE
  if ($null -ne $output) { $output | ForEach-Object { $_ } }
  if ($agentExitCode -eq 0 -and ($output | Out-String) -match '"finalAssistant(Raw|Visible)Text":\\s*"OK"') {
    $agentOk = $true
    break
  }
  if ($agentExitCode -ne 0 -and $attempt -lt 2 -and (Repair-MissingCodexPlatformPackage -Output $output)) {
    Write-Host "agent turn attempt $attempt hit a missing Codex platform package; retrying"
    continue
  }
  if ($attempt -lt 2) {
    Write-Host "agent turn attempt $attempt finished without OK response; retrying"
    Start-Sleep -Seconds 3
  }
  if ($agentExitCode -ne 0) { throw "agent failed with exit code $agentExitCode" }
}
if (-not $agentOk) { throw 'openclaw agent finished without OK response' }`;
}

export function macosUpdateScript(input: NpmUpdateScriptInput): string {
  return String.raw`set -euo pipefail
export PATH=${macosGuestPath}
${posixPrintLogTailFunction()}
resolve_required_command() {
  command -v "$1" || {
    echo "required command not found on PATH: $1" >&2
    exit 127
  }
}
OPENCLAW_BIN="$(resolve_required_command openclaw)"
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
  OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 "$OPENCLAW_BIN" gateway stop || true
  pkill -f 'openclaw.*gateway' >/dev/null 2>&1 || true
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -tiTCP:18789 -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      kill $pids >/dev/null 2>&1 || true
      sleep 2
      kill -9 $pids >/dev/null 2>&1 || true
    fi
  fi
}
start_openclaw_gateway() {
  stop_openclaw_gateway_processes
  rm -f /tmp/openclaw-parallels-macos-gateway.log
  trap '' HUP
  /usr/bin/env OPENCLAW_HOME="$HOME" OPENCLAW_STATE_DIR="$HOME/.openclaw" OPENCLAW_CONFIG_PATH="$HOME/.openclaw/openclaw.json" ${input.auth.apiKeyEnv}=${shellQuote(
    input.auth.apiKeyValue,
  )} "$OPENCLAW_BIN" gateway run --bind loopback --port 18789 --force >/tmp/openclaw-parallels-macos-gateway.log 2>&1 </dev/null &
  sleep 1
}
wait_for_gateway() {
  deadline=$((SECONDS + 240))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if "$OPENCLAW_BIN" gateway status --deep --require-rpc --timeout 15000; then
      return
    fi
    sleep 2
  done
  print_log_tail /tmp/openclaw-parallels-macos-gateway.log >&2
  echo "gateway did not become ready after update" >&2
  exit 1
}
scrub_future_plugin_entries
stop_openclaw_gateway_processes
${posixNpmRegistryEnv(input.npmRegistry)}OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1 OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 "$OPENCLAW_BIN" update --tag ${shellQuote(input.updateTarget)} --yes --json --no-restart
${posixVersionCheck(macosOpenClawCommand, input.expectedNeedle)}
start_openclaw_gateway
wait_for_gateway
"$OPENCLAW_BIN" models set ${shellQuote(input.auth.modelId)}
${posixModelProviderConfigCommands(macosOpenClawCommand, input.auth.modelId, "macos")}
"$OPENCLAW_BIN" config set agents.defaults.skipBootstrap true --strict-json
"$OPENCLAW_BIN" config set tools.profile minimal
${posixAgentWorkspaceScript("Parallels npm update smoke test assistant.")}
${posixAssertAgentOkScript(macosOpenClawCommand, input, "macos", "parallels-npm-update-macos")}`;
}

export function windowsUpdateScript(input: NpmUpdateScriptInput): string {
  return `$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
${windowsOpenClawResolver}
${windowsScopedEnvFunction}
function Remove-FuturePluginEntries {
  $configPath = Join-Path $env:USERPROFILE '.openclaw\\openclaw.json'
  if (-not (Test-Path $configPath)) { return }
  $nodeScript = @'
const fs = require("node:fs");
const configPath = process.argv[2];
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\\uFEFF/u, ""));
} catch {
  process.exit(0);
}
const plugins = config.plugins;
if (!plugins || typeof plugins !== "object") {
  process.exit(0);
}
const futurePluginIds = new Set(["feishu", "whatsapp", "openai"]);
let changed = false;
if (plugins.entries && typeof plugins.entries === "object") {
  for (const pluginId of futurePluginIds) {
    if (Object.hasOwn(plugins.entries, pluginId)) {
      delete plugins.entries[pluginId];
      changed = true;
    }
  }
}
if (Array.isArray(plugins.allow)) {
  const allow = plugins.allow.filter((pluginId) => !futurePluginIds.has(pluginId));
  if (allow.length !== plugins.allow.length) {
    plugins.allow = allow;
    changed = true;
  }
}
if (changed) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\\n");
}
'@
  $nodeScriptPath = Join-Path ([System.IO.Path]::GetTempPath()) ('openclaw-future-plugin-scrub-' + [guid]::NewGuid().ToString('N') + '.cjs')
  try {
    $nodeScript | Set-Content -Path $nodeScriptPath -Encoding UTF8
    & node.exe $nodeScriptPath $configPath
    if ($LASTEXITCODE -ne 0) { throw "failed to scrub future plugin entries" }
  } finally {
    Remove-Item $nodeScriptPath -Force -ErrorAction SilentlyContinue
  }
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
${windowsUpdateWithBundledPluginsDisabled(input)}
if ($updateExit -ne 0) {
  $updateText = $updateOutput | Out-String
  $stalePostSwapImport = $updateText -match 'ERR_MODULE_NOT_FOUND' -and $updateText -match ${psSingleQuote(windowsStalePostSwapImportRegex)}
  if (-not $stalePostSwapImport) { throw "openclaw update failed with exit code $updateExit" }
  Write-Host "openclaw update returned a stale post-swap module import; continuing to post-update health checks"
}
${windowsVersionCheck(input.expectedNeedle)}
${windowsGatewayReadyScript()}
${windowsAssertAgentOkScript(input)}`;
}

export function linuxUpdateScript(input: NpmUpdateScriptInput): string {
  return String.raw`set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/snap/bin
export OPENCLAW_ALLOW_ROOT=1
${posixPrintLogTailFunction()}
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
  OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 OPENCLAW_ALLOW_ROOT=1 openclaw gateway stop || true
  pkill -f 'openclaw.*gateway' >/dev/null 2>&1 || true
}
start_openclaw_gateway() {
  pkill -f "openclaw gateway run" >/dev/null 2>&1 || true
  rm -f /tmp/openclaw-parallels-linux-gateway.log
  setsid sh -lc ${shellQuote(
    `exec env OPENCLAW_HOME=/root OPENCLAW_STATE_DIR=/root/.openclaw OPENCLAW_CONFIG_PATH=/root/.openclaw/openclaw.json OPENCLAW_DISABLE_BONJOUR=1 OPENCLAW_ALLOW_ROOT=1 ${input.auth.apiKeyEnv}=${shellQuote(
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
  print_log_tail /tmp/openclaw-parallels-linux-gateway.log >&2
  echo "gateway did not become ready after update" >&2
  exit 1
}
scrub_future_plugin_entries
stop_openclaw_gateway_processes
${posixNpmRegistryEnv(input.npmRegistry)}OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1 OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 openclaw update --tag ${shellQuote(input.updateTarget)} --yes --json --no-restart
${posixVersionCheck("openclaw", input.expectedNeedle)}
start_openclaw_gateway
wait_for_gateway
openclaw models set ${shellQuote(input.auth.modelId)}
${posixModelProviderConfigCommands("openclaw", input.auth.modelId, "linux")}
openclaw config set agents.defaults.skipBootstrap true --strict-json
openclaw config set tools.profile minimal
${posixAgentWorkspaceScript("Parallels npm update smoke test assistant.")}
${posixAssertAgentOkScript("openclaw", input, "linux", "parallels-npm-update-linux")}`;
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
