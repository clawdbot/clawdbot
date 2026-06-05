// Plugin Isolation script supports OpenClaw repository automation.
import { shellQuote } from "./host-command.ts";
import { providerIdFromModelId } from "./provider-auth.ts";

interface PluginIsolationOptions {
  fallbackPluginId: string;
  homeFallback?: string;
  modelId: string;
  nodeCommand?: string;
}

export function providerOnlyPluginId(modelId: string, fallbackPluginId: string): string {
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
$isolationScriptPath = Join-Path ([System.IO.Path]::GetTempPath()) 'openclaw-parallels-plugin-isolation.cjs'
@'
${providerOnlyPluginIsolationNodeSource()}
'@ | Set-Content -Path $isolationScriptPath -Encoding UTF8
node.exe $isolationScriptPath
if ($LASTEXITCODE -ne 0) { throw "plugin isolation failed with exit code $LASTEXITCODE" }
Remove-Item $isolationScriptPath -Force -ErrorAction SilentlyContinue
Remove-Item Env:OPENCLAW_PARALLELS_PLUGIN_ISOLATION -Force -ErrorAction SilentlyContinue`;
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
