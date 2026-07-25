// Plugin Isolation script supports OpenClaw repository automation.
import { shellQuote } from "./host-command.ts";
import { providerIdFromModelId } from "./provider-auth.ts";

interface PluginIsolationOptions {
  fallbackPluginId: string;
  homeFallback?: string;
  modelId: string;
  nodeCommand?: string;
}

export function posixCodexPlatformPackageRepairFunction(): string {
  return `repair_missing_codex_platform_package() {
  output_file="$1"
  grep -F 'Missing optional dependency @openai/codex-' "$output_file" >/dev/null 2>&1 || return 1
  state_home="\${OPENCLAW_PARALLELS_HOME:-\${HOME:-}}"
  codex_manifest=""
  for candidate in "$state_home"/.openclaw/npm/projects/*/node_modules/@openclaw/codex/package.json; do
    [ -f "$candidate" ] || continue
    codex_manifest="$candidate"
    break
  done
  if [ -z "$codex_manifest" ]; then
    echo "codex-platform-repair: managed Codex project not found" >&2
    return 1
  fi
  project_root="\${codex_manifest%/node_modules/@openclaw/codex/package.json}"
  cache_dir="$(mktemp -d "\${TMPDIR:-/tmp}/openclaw-npm-cache.XXXXXX")"
  echo "codex-platform-repair: retrying managed npm install once with a fresh cache" >&2
  repair_rc=0
  (
    cd "$project_root"
    NPM_CONFIG_CACHE="$cache_dir" npm_config_cache="$cache_dir" npm install --omit=dev --omit=peer --legacy-peer-deps --ignore-scripts --no-audit --no-fund
  ) || repair_rc=$?
  rm -rf "$cache_dir"
  if [ "$repair_rc" -ne 0 ]; then
    echo "codex-platform-repair: npm install failed with exit code $repair_rc" >&2
    return "$repair_rc"
  fi
  echo "codex-platform-repair: managed npm install completed" >&2
}`;
}

export function windowsCodexPlatformPackageRepairFunction(): string {
  return String.raw`function Repair-MissingCodexPlatformPackage {
  param([object[]] $Output)
  $outputText = $Output | Out-String
  if ($outputText -notmatch [regex]::Escape('Missing optional dependency @openai/codex-')) {
    return $false
  }
  $projectsRoot = Join-Path $env:USERPROFILE '.openclaw\npm\projects'
  $codexManifest = Get-ChildItem -Path $projectsRoot -Filter package.json -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'node_modules[\\/]@openclaw[\\/]codex[\\/]package\.json$' } |
    Select-Object -First 1
  if (-not $codexManifest) {
    Write-Warning 'codex-platform-repair: managed Codex project not found'
    return $false
  }
  $projectRoot = $codexManifest.Directory.Parent.Parent.Parent.FullName
  $cacheDir = Join-Path ([System.IO.Path]::GetTempPath()) ('openclaw-npm-cache-' + [guid]::NewGuid().ToString('N'))
  $oldUpperCache = [Environment]::GetEnvironmentVariable('NPM_CONFIG_CACHE', 'Process')
  $oldLowerCache = [Environment]::GetEnvironmentVariable('npm_config_cache', 'Process')
  $pushedLocation = $false
  $repairExit = 1
  try {
    New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
    [Environment]::SetEnvironmentVariable('NPM_CONFIG_CACHE', $cacheDir, 'Process')
    [Environment]::SetEnvironmentVariable('npm_config_cache', $cacheDir, 'Process')
    Push-Location $projectRoot
    $pushedLocation = $true
    Write-Host 'codex-platform-repair: retrying managed npm install once with a fresh cache'
    $repairOutput = & npm.cmd install --omit=dev --omit=peer --legacy-peer-deps --ignore-scripts --no-audit --no-fund 2>&1
    $repairExit = $LASTEXITCODE
    if ($null -ne $repairOutput) { $repairOutput | ForEach-Object { Write-Host $_ } }
  } finally {
    if ($pushedLocation) { Pop-Location }
    [Environment]::SetEnvironmentVariable('NPM_CONFIG_CACHE', $oldUpperCache, 'Process')
    [Environment]::SetEnvironmentVariable('npm_config_cache', $oldLowerCache, 'Process')
    Remove-Item $cacheDir -Force -Recurse -ErrorAction SilentlyContinue
  }
  if ($repairExit -ne 0) {
    Write-Warning "codex-platform-repair: npm install failed with exit code $repairExit"
    return $false
  }
  Write-Host 'codex-platform-repair: managed npm install completed'
  return $true
}`;
}

function providerOnlyPluginId(modelId: string, fallbackPluginId: string): string {
  return providerIdFromModelId(modelId) || fallbackPluginId;
}

export function posixProviderOnlyPluginIsolationScript(options: PluginIsolationOptions): string {
  const nodeCommand = shellQuote(options.nodeCommand ?? "node");
  const homeEnv = options.homeFallback
    ? `OPENCLAW_PARALLELS_HOME=${shellQuote(options.homeFallback)} `
    : "";
  return `/usr/bin/env ${homeEnv}${nodeCommand} - <<'JS'
${providerOnlyPluginIsolationNodeScript(options)}
JS`;
}

export function windowsProviderOnlyPluginIsolationScript(options: PluginIsolationOptions): string {
  const payloadJson = JSON.stringify({
    modelId: options.modelId,
    pluginId: providerOnlyPluginId(options.modelId, options.fallbackPluginId),
  });
  return `$env:OPENCLAW_PARALLELS_PLUGIN_ISOLATION = @'
${payloadJson}
'@
$isolationScriptPath = Join-Path ([System.IO.Path]::GetTempPath()) ('openclaw-parallels-plugin-isolation-' + [guid]::NewGuid().ToString('N') + '.cjs')
try {
@'
${providerOnlyPluginIsolationNodeSource()}
'@ | Set-Content -Path $isolationScriptPath -Encoding UTF8
node.exe $isolationScriptPath
if ($LASTEXITCODE -ne 0) { throw "plugin isolation failed with exit code $LASTEXITCODE" }
} finally {
  Remove-Item $isolationScriptPath -Force -ErrorAction SilentlyContinue
  Remove-Item Env:OPENCLAW_PARALLELS_PLUGIN_ISOLATION -Force -ErrorAction SilentlyContinue
}`;
}

function providerOnlyPluginIsolationNodeScript(options: PluginIsolationOptions): string {
  const payloadJson = JSON.stringify({
    homeFallback: options.homeFallback,
    modelId: options.modelId,
    pluginId: providerOnlyPluginId(options.modelId, options.fallbackPluginId),
  });
  return `process.env.OPENCLAW_PARALLELS_PLUGIN_ISOLATION = ${JSON.stringify(payloadJson)};
${providerOnlyPluginIsolationNodeSource()}`;
}

function providerOnlyPluginIsolationNodeSource(): string {
  return String.raw`const fs = require("node:fs");
const path = require("node:path");

const payload = JSON.parse(process.env.OPENCLAW_PARALLELS_PLUGIN_ISOLATION || "{}");
const home =
  process.env.OPENCLAW_PARALLELS_HOME ||
  payload.homeFallback ||
  process.env.HOME ||
  process.env.USERPROFILE ||
  "/root";
const configPath = path.join(home, ".openclaw", "openclaw.json");
const stateDir = path.dirname(configPath);
const modelId = String(payload.modelId || "");
const allowedPluginId = String(payload.pluginId || "").trim();
if (!allowedPluginId || !modelId) {
  throw new Error("missing plugin isolation payload");
}

const readConfig = () => {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
};
const objectRecord = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const config = readConfig();
config.plugins = objectRecord(config.plugins);
config.plugins.entries = { [allowedPluginId]: { enabled: true } };
config.plugins.allow = [allowedPluginId];

config.agents = objectRecord(config.agents);
config.agents.defaults = objectRecord(config.agents.defaults);
config.agents.defaults.model = {
  ...objectRecord(config.agents.defaults.model),
  primary: modelId,
};
config.agents.defaults.models = objectRecord(config.agents.defaults.models);
const selectedModelEntry = config.agents.defaults.models[modelId];
if (selectedModelEntry && typeof selectedModelEntry === "object" && !Array.isArray(selectedModelEntry)) {
  delete selectedModelEntry.agentRuntime;
}

const providerId = modelId.split("/", 1)[0] || "";
const providerModelId = modelId.slice(providerId.length + 1);
const providers = objectRecord(objectRecord(config.models).providers);
const providerEntry = providers[providerId];
if (providerEntry && typeof providerEntry === "object" && !Array.isArray(providerEntry)) {
  delete providerEntry.agentRuntime;
  if (Array.isArray(providerEntry.models)) {
    for (const model of providerEntry.models) {
      if (
        model &&
        typeof model === "object" &&
        (model.id === providerModelId ||
          model.id === modelId ||
          model.name === providerModelId ||
          model.name === modelId)
      ) {
        delete model.agentRuntime;
      }
    }
  }
}

fs.rmSync(path.join(stateDir, "npm", "node_modules", "@openclaw", "codex"), {
  recursive: true,
  force: true,
});
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");`;
}
