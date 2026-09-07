#!/usr/bin/env node
// Exercise Doctor through the installed candidate CLI, without an update or consent flags.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runManagedCommand, terminateManagedChild } from "../../../lib/managed-child-process.mts";
import { readPluginInstallRecords } from "../plugin-index-sqlite.mjs";

const expectedVersion = process.argv[2];
const runtimeRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;
const artifactRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
assert(
  expectedVersion && runtimeRoot && artifactRoot,
  "Doctor proof requires candidate version and survivor roots",
);
const proofRoot = fs.mkdtempSync(path.join(runtimeRoot, "formerly-bundled-doctor-"));
const proofArtifacts = path.join(artifactRoot, path.basename(proofRoot));
const home = path.join(proofRoot, "home");
const stateDir = path.join(home, ".openclaw");
const configPath = path.join(stateDir, "openclaw.json");
const workspace = path.join(proofRoot, "workspace");
for (const directory of [stateDir, workspace, proofArtifacts]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}
const env = {
  ...process.env,
  HOME: home,
  OPENCLAW_HOME: home,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_AGENT_DIR: path.join(stateDir, "agents", "main", "agent"),
  OPENCLAW_TEST_WORKSPACE_DIR: workspace,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  XDG_DATA_HOME: path.join(home, ".local", "share"),
};
delete env.OPENCLAW_PROFILE;

function writeJson(name, value) {
  fs.writeFileSync(path.join(proofArtifacts, name), `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}

function cli(name, args, { json = true, binary = "openclaw" } = {}) {
  console.log(`Formerly bundled Doctor proof: ${name}`);
  const result = spawnSync(binary, args, {
    cwd: workspace,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    killSignal: "SIGKILL",
  });
  fs.writeFileSync(path.join(proofArtifacts, `${name}.out`), result.stdout ?? "");
  fs.writeFileSync(path.join(proofArtifacts, `${name}.err`), result.stderr ?? "");
  writeJson(`${name}.command.json`, {
    binary,
    args,
    exitCode: result.status,
    signal: result.signal,
  });
  assert(
    !result.error && result.status !== null,
    `${name} did not complete; see ${proofArtifacts}`,
  );
  assert(result.status === 0, `${name}: unexpected exit ${result.status}; see ${proofArtifacts}`);
  if (!json) {
    return result.stdout;
  }
  const start = result.stdout.search(/^\s*[[{]/mu);
  assert(start >= 0, `${name} did not return JSON`);
  return JSON.parse(result.stdout.slice(start));
}

function assertInstalled(inventory) {
  const plugin = inventory.plugins?.find((entry) => entry.id === "duckduckgo");
  assert(plugin, "configured DuckDuckGo is missing from plugins list");
  assert.notEqual(plugin.origin, "bundled", "DuckDuckGo must be installed externally");
  assert.equal(plugin.version, expectedVersion, "DuckDuckGo must match the installed candidate");
  assert.notEqual(plugin.status, "error", "DuckDuckGo has a plugin load error");
  assert.equal(plugin.enabled, true, "Doctor disabled the configured DuckDuckGo plugin");
  return plugin;
}

const packageName = "@openclaw/duckduckgo-plugin";
const publishedVersion = "2026.8.1";
assert.notEqual(
  expectedVersion,
  publishedVersion,
  "Doctor proof requires candidate and latest to differ",
);
const prepublishRoot = process.env.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR;
assert(prepublishRoot, "Doctor proof requires the candidate plugin prepublish artifact");
const manifest = JSON.parse(
  fs.readFileSync(path.join(prepublishRoot, "prepublish-plugin-registry.json"), "utf8"),
);
const candidatePackage = manifest.packages.find((entry) => entry.name === packageName);
assert.equal(
  candidatePackage?.version,
  expectedVersion,
  "candidate DuckDuckGo prepublish artifact missing",
);
const published = cli(
  "published-package",
  [
    "pack",
    `${packageName}@${publishedVersion}`,
    "--json",
    "--ignore-scripts",
    "--registry=https://registry.npmjs.org",
    "--pack-destination",
    proofRoot,
  ],
  { binary: "npm" },
);
assert.equal(
  published[0]?.version,
  publishedVersion,
  "npm did not pack the published control version",
);
const portFile = path.join(proofRoot, "registry-port");
const registryLog = fs.openSync(path.join(proofArtifacts, "registry.log"), "w", 0o600);
const registryEnv = {
  ...env,
  OPENCLAW_NPM_REGISTRY_UPSTREAM: process.env.npm_config_registry || "https://registry.npmjs.org",
  OPENCLAW_NPM_REGISTRY_BIND_HOST: "127.0.0.1",
  OPENCLAW_NPM_REGISTRY_PORT: "0",
};
// Beta retains its tag policy; stable repair must ignore the stale latest tag.
registryEnv.OPENCLAW_NPM_REGISTRY_DIST_TAGS = `beta=${expectedVersion}`;
delete registryEnv.OPENCLAW_NPM_REGISTRY_MERGE_UPSTREAM;
// The last version becomes latest. Both manifests and archives are real package bytes.
let registry;
const registryRun = runManagedCommand({
  bin: process.execPath,
  args: [
    fileURLToPath(new URL("../plugins/npm-registry-server.mjs", import.meta.url)),
    portFile,
    packageName,
    expectedVersion,
    path.join(prepublishRoot, candidatePackage.tarball),
    packageName,
    publishedVersion,
    path.join(proofRoot, published[0].filename),
  ],
  env: registryEnv,
  stdio: ["ignore", registryLog, registryLog],
  requireProcessTreeExit: true,
  onReady: (child) => {
    registry = child;
  },
});
fs.closeSync(registryLog);
try {
  for (let attempt = 0; !fs.existsSync(portFile) && attempt < 100; attempt += 1) {
    assert.equal(registry.exitCode, null, "Doctor proof registry exited before readiness");
    await delay(100);
  }
  assert(fs.existsSync(portFile), "Doctor proof registry did not become ready");
  const registryUrl = `http://127.0.0.1:${fs.readFileSync(portFile, "utf8").trim()}`;
  env.npm_config_registry = registryUrl;
  env.NPM_CONFIG_REGISTRY = registryUrl;
  env.BUN_CONFIG_REGISTRY = registryUrl;
  const metadataResponse = await fetch(`${registryUrl}/${encodeURIComponent(packageName)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert(metadataResponse.ok, "Doctor proof registry metadata request failed");
  const metadata = await metadataResponse.json();
  assert.equal(
    metadata["dist-tags"].latest,
    publishedVersion,
    "fixture latest must differ from the candidate",
  );
  assert(metadata.versions[expectedVersion], "registry must retain the exact candidate");
  writeJson("registry-metadata.json", metadata);

  // Keep Doctor's Gateway probes away from the survivor's running managed Gateway.
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await promisify(listener.close.bind(listener))();
  env.OPENCLAW_GATEWAY_PORT = String(port);
  const config = {
    agents: { defaults: { workspace, model: { primary: "survivor/gpt-5.6-luna" } } },
    models: {
      providers: {
        survivor: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "survivor-doctor-fixture",
          models: [{ id: "gpt-5.6-luna", name: "Doctor fixture" }],
        },
      },
    },
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token: "formerly-bundled-doctor-fixture" },
    },
    tools: { web: { search: { provider: "duckduckgo", enabled: true } } },
    plugins: { allow: ["duckduckgo"], entries: { duckduckgo: { enabled: true } } },
  };
  // Seed retained historical configuration without installing the missing payload.
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  assert(
    !readPluginInstallRecords({ stateDir, configPath }).duckduckgo,
    "fixture already has an install record",
  );
  assert(
    !fs.existsSync(path.join(stateDir, "extensions", "duckduckgo")),
    "fixture already has plugin payload",
  );
  const before = cli("before-validate", ["config", "validate", "--json"]);
  assert.equal(before.valid, true, "missing optional plugins should remain repairable");
  assert(
    before.warnings?.some((issue) => issue.message.includes("plugin not installed: duckduckgo")),
    "fixture did not report missing DuckDuckGo",
  );
  const missing = cli("before-plugins", ["plugins", "list", "--json"]);
  // Negative control: the exact post-repair assertion must reject a skipped install.
  assert.throws(() => assertInstalled(missing), {
    message: "configured DuckDuckGo is missing from plugins list",
  });
  writeJson("skipped-install-negative-control.json", {
    rejected: true,
    reason: "configured DuckDuckGo is missing from plugins list",
  });

  cli("doctor-fix", ["doctor", "--fix", "--non-interactive"], { json: false });
  const plugin = assertInstalled(cli("after-plugins", ["plugins", "list", "--json"]));
  const inspect = cli("after-inspect", ["plugins", "inspect", "duckduckgo", "--json"]);
  assert.equal(inspect.install?.source, "npm", "Doctor did not install the official npm package");
  assert.equal(
    inspect.install?.resolvedVersion,
    expectedVersion,
    "install record has the wrong candidate version",
  );
  assert.equal(
    inspect.plugin.trustedOfficialInstall,
    true,
    "Doctor install was not verified as official",
  );
  assert.equal(
    inspect.install.acceptedSurface,
    undefined,
    "Doctor fabricated operator capability acceptance",
  );
  assert(inspect.install.installPath, "Doctor omitted the installed payload path");
  const payload = JSON.parse(
    fs.readFileSync(path.join(inspect.install.installPath, "package.json"), "utf8"),
  );
  assert.equal(
    payload.name,
    "@openclaw/duckduckgo-plugin",
    "Doctor installed the wrong npm package",
  );
  assert.equal(
    payload.version,
    expectedVersion,
    "installed payload has the wrong candidate version",
  );
  const after = cli("after-validate", ["config", "validate", "--json"]);
  assert.equal(after.valid, true, "Doctor left the configured plugin invalid");
  assert.deepEqual(after.warnings, [], "Doctor left unresolved config warnings");
  const repairedConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(
    repairedConfig.tools?.web?.search?.provider,
    "duckduckgo",
    "Doctor changed the selected search provider",
  );
  assert.equal(
    repairedConfig.tools?.web?.search?.enabled,
    true,
    "Doctor disabled search to hide the missing plugin",
  );
  writeJson("evidence.json", {
    candidateVersion: expectedVersion,
    registryLatest: publishedVersion,
    configPath,
    initialValidation: before,
    skippedInstallRejected: true,
    repairCommand: ["openclaw", "doctor", "--fix", "--non-interactive"],
    plugin: { id: plugin.id, version: plugin.version, origin: plugin.origin },
    install: { source: inspect.install.source, name: payload.name, version: payload.version },
    capabilityConsent: "trusted-official exemption; no operator acceptance recorded",
    finalValidation: after,
  });
  console.log(`Formerly bundled Doctor proof passed: ${proofArtifacts}/evidence.json`);
} finally {
  terminateManagedChild(registry, "SIGKILL");
  await registryRun;
}
