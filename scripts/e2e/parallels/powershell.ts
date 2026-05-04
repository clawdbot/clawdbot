import {
  configPathMapKey,
  modelProviderConfigBatchJson,
  providerIdFromModelId,
  providerTimeoutConfigJson,
} from "./provider-auth.ts";

export function psSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function psArray(values: string[]): string {
  return `@(${values.map(psSingleQuote).join(", ")})`;
}

export function encodePowerShell(script: string): string {
  return Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${script}`, "utf16le").toString(
    "base64",
  );
}

export const windowsScopedEnvFunction = String.raw`function Invoke-WithScopedEnv {
  param(
    [Parameter(Mandatory = $true)][hashtable] $Values,
    [Parameter(Mandatory = $true)][scriptblock] $Script
  )
  $previous = @{}
  foreach ($key in $Values.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable([string]$key, 'Process')
    Set-Item -Path ('Env:' + $key) -Value ([string]$Values[$key])
  }
  try {
    & $Script
  } finally {
    foreach ($key in $Values.Keys) {
      if ($null -eq $previous[$key]) {
        Remove-Item -Path ('Env:' + $key) -ErrorAction SilentlyContinue
      } else {
        Set-Item -Path ('Env:' + $key) -Value $previous[$key]
      }
    }
  }
}`;

export function windowsModelProviderTimeoutScript(modelId: string): string {
  const providerId = providerIdFromModelId(modelId);
  const configJson = providerTimeoutConfigJson(modelId, "windows");
  if (!providerId || !configJson) {
    return "";
  }
  const batchJson = JSON.stringify([
    {
      path: `models.providers.${providerId}`,
      value: JSON.parse(configJson) as unknown,
    },
    {
      path: `agents.defaults.models${configPathMapKey(modelId)}`,
      value: {
        alias: "GPT",
        params: {
          transport: "sse",
        },
      },
    },
  ]);
  return `$providerTimeoutBatchPath = Join-Path ([System.IO.Path]::GetTempPath()) 'openclaw-provider-timeout.batch.json'
@'
${batchJson}
'@ | Set-Content -Path $providerTimeoutBatchPath -Encoding UTF8
Invoke-OpenClaw config set --batch-file $providerTimeoutBatchPath --strict-json
$providerTimeoutExit = $LASTEXITCODE
Remove-Item $providerTimeoutBatchPath -Force -ErrorAction SilentlyContinue
if ($providerTimeoutExit -ne 0) { throw "model provider timeout config set failed" }`;
}

export function windowsAgentTurnConfigPatchScript(modelId: string): string {
  const batchJson = modelProviderConfigBatchJson(modelId, "windows");
  const payloadJson = JSON.stringify({
    modelId,
    operations: batchJson ? (JSON.parse(batchJson) as unknown) : [],
  });
  return `$agentTurnConfigPatchPath = $env:OPENCLAW_CONFIG_PATH
if (-not $agentTurnConfigPatchPath) { $agentTurnConfigPatchPath = Join-Path $env:USERPROFILE '.openclaw\\openclaw.json' }
$env:OPENCLAW_PARALLELS_AGENT_CONFIG_PATCH = @'
${payloadJson}
'@
$env:OPENCLAW_PARALLELS_AGENT_CONFIG_PATH = $agentTurnConfigPatchPath
$agentTurnConfigPatchScriptPath = Join-Path ([System.IO.Path]::GetTempPath()) 'openclaw-agent-turn-config-patch.cjs'
@'
const fs = require("node:fs");
const path = require("node:path");
const configPath = process.env.OPENCLAW_PARALLELS_AGENT_CONFIG_PATH;
const payload = JSON.parse(process.env.OPENCLAW_PARALLELS_AGENT_CONFIG_PATCH || "{}");
function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\\uFEFF/u, ""));
}
const cfg = fs.existsSync(configPath) ? readJsonFile(configPath) : {};
cfg.agents = cfg.agents && typeof cfg.agents === "object" ? cfg.agents : {};
cfg.agents.defaults = cfg.agents.defaults && typeof cfg.agents.defaults === "object" ? cfg.agents.defaults : {};
cfg.agents.defaults.skipBootstrap = true;
const existingModel = cfg.agents.defaults.model && typeof cfg.agents.defaults.model === "object" ? cfg.agents.defaults.model : {};
cfg.agents.defaults.model = { ...existingModel, primary: payload.modelId };
cfg.agents.defaults.models = cfg.agents.defaults.models && typeof cfg.agents.defaults.models === "object" ? cfg.agents.defaults.models : {};
cfg.tools = cfg.tools && typeof cfg.tools === "object" ? cfg.tools : {};
cfg.tools.profile = "minimal";
for (const op of payload.operations || []) {
  const segments = String(op.path || "").match(/(?:[^.[\\]]+)|(?:\\["((?:\\\\.|[^"\\\\])*)"\\])/g) || [];
  let cursor = cfg;
  for (let i = 0; i < segments.length; i++) {
    const raw = segments[i];
    const key = raw.startsWith("[") ? JSON.parse(raw.slice(1, -1)) : raw;
    if (i === segments.length - 1) {
      const existing = cursor[key] && typeof cursor[key] === "object" && !Array.isArray(cursor[key]) ? cursor[key] : {};
      cursor[key] = op.value && typeof op.value === "object" && !Array.isArray(op.value) ? { ...existing, ...op.value } : op.value;
    } else {
      cursor[key] = cursor[key] && typeof cursor[key] === "object" && !Array.isArray(cursor[key]) ? cursor[key] : {};
      cursor = cursor[key];
    }
  }
}
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\\n", { mode: 0o600 });
'@ | Set-Content -Path $agentTurnConfigPatchScriptPath -Encoding UTF8
node.exe $agentTurnConfigPatchScriptPath
$agentTurnConfigPatchExit = $LASTEXITCODE
Remove-Item $agentTurnConfigPatchScriptPath -Force -ErrorAction SilentlyContinue
Remove-Item Env:OPENCLAW_PARALLELS_AGENT_CONFIG_PATCH -Force -ErrorAction SilentlyContinue
Remove-Item Env:OPENCLAW_PARALLELS_AGENT_CONFIG_PATH -Force -ErrorAction SilentlyContinue
if ($agentTurnConfigPatchExit -ne 0) { throw "agent turn config patch failed" }`;
}

export const windowsOpenClawResolver = String.raw`function Resolve-OpenClawCommand {
  if ($script:OpenClawResolvedCommand) { return $script:OpenClawResolvedCommand }
  $shimCandidates = @()
  if ($env:APPDATA) {
    $shimCandidates += Join-Path $env:APPDATA 'npm\openclaw.cmd'
    $shimCandidates += Join-Path $env:APPDATA 'npm\openclaw.ps1'
  }
  foreach ($name in @('openclaw.cmd', 'openclaw.ps1', 'openclaw')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command -and $command.Source) { $shimCandidates += $command.Source }
  }
  $npmPrefix = $null
  try {
    $npmPrefix = (& npm.cmd prefix -g 2>$null | Select-Object -First 1)
  } catch {}
  if ($npmPrefix) {
    $shimCandidates += Join-Path $npmPrefix 'openclaw.cmd'
    $shimCandidates += Join-Path $npmPrefix 'openclaw.ps1'
  }
  foreach ($candidate in $shimCandidates) {
    if ($candidate -and (Test-Path $candidate)) {
      $script:OpenClawResolvedCommand = @{ Kind = 'shim'; Path = $candidate }
      return $script:OpenClawResolvedCommand
    }
  }
  $entryCandidates = @()
  if ($env:APPDATA) {
    $entryCandidates += Join-Path $env:APPDATA 'npm\node_modules\openclaw\openclaw.mjs'
  }
  if ($npmPrefix) {
    $entryCandidates += Join-Path $npmPrefix 'node_modules\openclaw\openclaw.mjs'
  }
  foreach ($candidate in $entryCandidates) {
    if ($candidate -and (Test-Path $candidate)) {
      $script:OpenClawResolvedCommand = @{ Kind = 'node'; Path = $candidate }
      return $script:OpenClawResolvedCommand
    }
  }
  throw 'openclaw command not found in PATH, APPDATA npm, or npm global prefix'
}
function Invoke-OpenClaw {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]] $OpenClawArgs)
  $command = Resolve-OpenClawCommand
  $previousErrorActionPreference = $ErrorActionPreference
  $previousNativeErrorActionPreference = $PSNativeCommandUseErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $PSNativeCommandUseErrorActionPreference = $false
  try {
    if ($command.Kind -eq 'node') {
      & node.exe $command.Path @OpenClawArgs
    } else {
      & $command.Path @OpenClawArgs
    }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $previousNativeErrorActionPreference
  }
}`;
