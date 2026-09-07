import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { assertAgentReplyContainsMarker } from "../agent-turn-output.mjs";
import { readTcpPortEnv } from "../env-limits.mjs";
import { readPluginInstallIndex } from "../plugin-index-sqlite.mjs";

const MODEL = "survivor/gpt-5.6-luna";
const JOBS = [
  { name: "survivor-default-owner", agentId: "main" },
  { name: "survivor-ops-owner", agentId: "ops" },
];
const SKILL =
  "---\nname: survivor-workspace\ndescription: Synthetic upgrade survivor workspace skill.\n---\n\nKeep this workspace intact across upgrades.\n";

function requiredEnv(name) {
  assert(process.env[name], `${name} is required`);
  return process.env[name];
}

function artifact(name) {
  return path.join(requiredEnv("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT"), name);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function cli(args, label, { json = false, privateOutput = false, env = process.env } = {}) {
  const result = spawnSync("openclaw", args, {
    encoding: "utf8",
    env,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    killSignal: "SIGKILL",
  });
  if (!privateOutput) {
    fs.writeFileSync(artifact(`${label}.out`), result.stdout ?? "");
    fs.writeFileSync(artifact(`${label}.err`), result.stderr ?? "");
  }
  assert.equal(
    result.status,
    0,
    `${label} failed (exit ${result.status}, signal ${result.signal}); see scenario artifacts`,
  );
  if (!json) {
    return result.stdout;
  }
  // Released CLIs may print plugin notices before their JSON result.
  const start = result.stdout.search(/^\s*\{/mu);
  assert(start >= 0, `${label} did not return JSON`);
  try {
    return JSON.parse(result.stdout.slice(start));
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

function authoredPolicy(value) {
  return {
    version: value?.version,
    defaults: value?.defaults,
    agents: value?.agents,
  };
}

function baselinePolicy(value) {
  const policy = structuredClone(authoredPolicy(value));
  // JSON-era CLIs wrote unused usage fields as null. Doctor removes those
  // placeholders; the complete authored policy and real usage must survive.
  for (const agent of Object.values(policy.agents ?? {})) {
    for (const entry of agent.allowlist ?? []) {
      for (const key of ["lastUsedAt", "lastUsedCommand", "lastResolvedPath"]) {
        if (entry[key] === null) {
          delete entry[key];
        }
      }
    }
  }
  return policy;
}

function approvalsCommand() {
  const help = cli(["--help"], "legacy-operator-cli-help");
  // Both names appeared in published CLI surfaces. Select from help, never by
  // retrying a failed mutation against a different command.
  return /^\s+approvals\b/mu.test(help) ? "approvals" : "exec-approvals";
}

export function seedLegacyOperatorState() {
  const workspace = requiredEnv("OPENCLAW_TEST_WORKSPACE_DIR");
  const mockPort = readTcpPortEnv("OPENCLAW_UPGRADE_SURVIVOR_MOCK_PORT", 44081);
  const set = (key, value) =>
    cli(
      ["config", "set", key, JSON.stringify(value), "--strict-json"],
      `legacy-operator-config-${key}`,
    );
  // Only transport and model setup uses config set. Every state specimen below
  // is authored by the installed baseline, preserving its native storage era.
  set("gateway", {
    mode: "local",
    port: 18789,
    bind: "loopback",
    reload: { mode: "off" },
    auth: {
      mode: "token",
      token: { source: "env", provider: "default", id: "GATEWAY_AUTH_TOKEN_REF" },
    },
  });
  set("models.providers.survivor", {
    baseUrl: `http://127.0.0.1:${mockPort}/v1`,
    api: "openai-completions",
    apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    models: [
      {
        id: "gpt-5.6-luna",
        name: "Survivor mock",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });
  const setupHelp = cli(["setup", "--help"], "legacy-operator-setup-help");
  cli(
    [
      "setup",
      ...(setupHelp.includes("--baseline") ? ["--baseline"] : []),
      "--workspace",
      workspace,
    ],
    "legacy-operator-setup",
  );
  set("agents.defaults.model.primary", MODEL);
  // Every fixture client shares this container's loopback network namespace.
  set("plugins.entries.device-pair", {
    enabled: true,
    config: { publicUrl: "ws://127.0.0.1:18789" },
  });
  unsetSystemAgent();
  writeJson(artifact("legacy-operator-baseline.json"), {});
  const skillPath = path.join(workspace, "skills", "survivor-workspace", "SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, SKILL);
  fs.writeFileSync(
    path.join(workspace, "IDENTITY.md"),
    "# Upgrade Survivor\n\nSynthetic operator workspace.\n",
  );
}

export function seedLegacyOperatorExternalPlugin() {
  const inventory = cli(["plugins", "list", "--json"], "legacy-operator-baseline-plugins", {
    json: true,
  });
  const bundled = inventory.plugins?.some(
    (plugin) => plugin.id === "duckduckgo" && plugin.origin === "bundled",
  );
  const entry = {
    enabled: true,
    config: { webSearch: { region: "us-en", safeSearch: "moderate" } },
  };
  if (bundled) {
    // This is the published bundled-era web-search configuration, authored by its CLI.
    cli(["plugins", "enable", "duckduckgo"], "legacy-operator-enable-duckduckgo");
    for (const [key, value] of Object.entries({
      "plugins.entries.duckduckgo": entry,
      "tools.web.search.provider": "duckduckgo",
      "tools.web.search.enabled": true,
    })) {
      cli(["config", "set", key, JSON.stringify(value), "--strict-json"], `legacy-operator-${key}`);
    }
    cli(["config", "validate", "--json"], "legacy-operator-duckduckgo-baseline-validate", {
      json: true,
    });
  } else {
    // Recreate an earlier upgrade that retained config but lost the bundled payload.
    // Seed only after the healthy baseline Gateway/CLI specimens have been captured.
    assert(
      !inventory.plugins?.some((plugin) => plugin.id === "duckduckgo"),
      "baseline DuckDuckGo already installed",
    );
    const configPath = requiredEnv("OPENCLAW_CONFIG_PATH");
    const config = readJson(configPath);
    config.plugins ??= {};
    config.plugins.entries ??= {};
    config.plugins.entries.duckduckgo = entry;
    if (Array.isArray(config.plugins.allow) && !config.plugins.allow.includes("duckduckgo")) {
      config.plugins.allow.push("duckduckgo");
    }
    config.tools ??= {};
    config.tools.web ??= {};
    config.tools.web.search = { ...config.tools.web.search, provider: "duckduckgo", enabled: true };
    writeJson(configPath, config);
  }
  const records = readPluginInstallIndex({
    stateDir: requiredEnv("OPENCLAW_STATE_DIR"),
  }).installRecords;
  assert(!records?.duckduckgo, "formerly bundled plugin must have no baseline install record");
  writeJson(artifact("legacy-operator-external-plugin.json"), {
    pluginId: "duckduckgo",
    packageName: "@openclaw/duckduckgo-plugin",
    baselineState: bundled ? "bundled" : "missing",
    installRecord: null,
  });
  console.log(
    `Seeded configured DuckDuckGo without an install record (${bundled ? "bundled" : "already missing"}).`,
  );
}

export function assertLegacyOperatorExternalPlugin(expectedVersion) {
  const inventory = cli(["plugins", "list", "--json"], "legacy-operator-candidate-plugins", {
    json: true,
  });
  const plugin = inventory.plugins?.find((entry) => entry.id === "duckduckgo");
  assert(plugin, "plugins list omitted configured DuckDuckGo");
  assert.notEqual(plugin.origin, "bundled", "DuckDuckGo must converge to an external package");
  assert.equal(
    plugin.version,
    expectedVersion,
    "plugins list reported the wrong DuckDuckGo version",
  );
  assert.notEqual(plugin.status, "error", "plugins list reported a DuckDuckGo load error");
  assert.equal(plugin.enabled, true, "DuckDuckGo was disabled during the update");
  const validation = cli(
    ["config", "validate", "--json"],
    "legacy-operator-external-plugin-validate",
    { json: true },
  );
  assert.equal(
    validation.valid,
    true,
    "config validation failed after external plugin convergence",
  );
  assert.deepEqual(
    validation.warnings,
    [],
    "config validation reported unresolved plugin warnings",
  );
}

function seedLegacyOperatorApprovals() {
  const approvals = approvalsCommand();
  const policyInput = artifact("legacy-operator-policy-input.json");
  writeJson(policyInput, {
    version: 1,
    defaults: { security: "allowlist", ask: "off", askFallback: "deny" },
    agents: {},
  });
  cli([approvals, "set", "--file", policyInput, "--json"], "legacy-operator-approvals-set", {
    privateOutput: true,
  });
  fs.rmSync(policyInput);
  for (const [agent, pattern] of [
    ["main", "/usr/bin/uname"],
    ["ops", "/usr/bin/date"],
  ]) {
    cli(
      [approvals, "allowlist", "add", "--agent", agent, pattern, "--json"],
      `legacy-operator-approvals-${agent}`,
      { privateOutput: true },
    );
  }
  const initialSnapshot = cli([approvals, "get", "--json"], "legacy-operator-approvals-get", {
    json: true,
    privateOutput: true,
  });
  // JSON-era get synthesizes missing entry IDs without saving them. Persist
  // that baseline-authored policy before recording the durable migration input.
  writeJson(policyInput, authoredPolicy(initialSnapshot.file));
  cli([approvals, "set", "--file", policyInput, "--json"], "legacy-operator-approvals-persist", {
    privateOutput: true,
  });
  fs.rmSync(policyInput);
  const snapshot = cli([approvals, "get", "--json"], "legacy-operator-approvals-capture", {
    json: true,
    privateOutput: true,
  });
  assert.equal(
    snapshot.file?.defaults?.security,
    "allowlist",
    "baseline approvals policy was not set",
  );
  const policy = baselinePolicy(snapshot.file);
  assert.equal(policy.agents?.main?.allowlist?.[0]?.pattern, "/usr/bin/uname");
  assert.equal(policy.agents?.ops?.allowlist?.[0]?.pattern, "/usr/bin/date");
  writeJson(artifact("legacy-operator-baseline.json"), {
    ...readJson(artifact("legacy-operator-baseline.json")),
    approvals: policy,
    approvalsJsonEra: fs.existsSync(
      path.join(requiredEnv("OPENCLAW_STATE_DIR"), "exec-approvals.json"),
    ),
  });
}

function unsetSystemAgent() {
  const config = readJson(requiredEnv("OPENCLAW_CONFIG_PATH"));
  if (config.agents?.defaults?.systemAgent !== undefined) {
    cli(["config", "unset", "agents.defaults.systemAgent"], "legacy-operator-unset-system-agent");
  }
}

function seedCronJob(job) {
  const created = cli(
    [
      "cron",
      "add",
      "--name",
      job.name,
      "--every",
      "24h",
      "--command",
      "printf survivor-cron",
      "--disabled",
      ...(job.agentId === "ops" ? ["--agent", "ops"] : []),
      "--json",
    ],
    `legacy-operator-add-${job.name}`,
    { json: true },
  );
  assert.equal(created.name, job.name, "baseline cron add returned the wrong job");
  assert(
    typeof created.id === "string" && created.id.length > 0,
    "baseline cron add omitted its job id",
  );
  assert.equal(
    created.agentId,
    job.agentId === "ops" ? "ops" : undefined,
    "baseline CLI changed the authored cron owner",
  );
  return { id: created.id, name: created.name, agentId: created.agentId };
}

export function seedLegacyOperatorDefaultCron() {
  const seeded = readJson(artifact("legacy-operator-baseline.json"));
  assert.equal(seeded.jobs, undefined, "baseline cron seed was already started");
  // 2026.9.2 refuses new ownerless jobs once the roster is ambiguous. Create
  // this ordinary operator job while main is still the sole configured agent.
  seeded.jobs = [seedCronJob(JOBS[0])];
  writeJson(artifact("legacy-operator-baseline.json"), seeded);
}

export function seedLegacyOperatorAgent() {
  const seeded = readJson(artifact("legacy-operator-baseline.json"));
  assert.equal(seeded.jobs?.length, 1, "create the default-owner cron job before adding ops");
  cli(
    [
      "agents",
      "add",
      "ops",
      "--workspace",
      path.join(requiredEnv("OPENCLAW_TEST_WORKSPACE_DIR"), "ops"),
      "--non-interactive",
      "--model",
      MODEL,
      "--json",
    ],
    "legacy-operator-add-ops",
  );
  unsetSystemAgent();
  // The approvals CLI validates named agents against the current roster.
  seedLegacyOperatorApprovals();
  assertLegacyOperatorConfig("baseline");
}

export function seedLegacyOperatorGatewayState() {
  const seeded = readJson(artifact("legacy-operator-baseline.json"));
  assert.equal(seeded.jobs?.length, 1, "baseline default-owner cron seed missing");
  seeded.jobs.push(seedCronJob(JOBS[1]));
  // Capture the baseline's own creation receipts. Its global list can reject
  // the now-ownerless first job; only the candidate must resolve both owners.
  writeJson(artifact("legacy-operator-baseline.json"), seeded);
  console.log(
    "Legacy operator baseline: two CLI-authored cron jobs; default owner remains unpinned.",
  );
}

export function assertLegacyOperatorConfig(stage) {
  const config = readJson(requiredEnv("OPENCLAW_CONFIG_PATH"));
  const agents =
    config.agents?.entries ??
    Object.fromEntries((config.agents?.list ?? []).map((entry) => [entry.id, entry]));
  assert(agents.main && agents.ops, "legacy operator main or ops agent missing");
  if (stage === "baseline") {
    assert.equal(
      config.agents?.defaults?.systemAgent,
      undefined,
      "legacy operator baseline must omit systemAgent",
    );
  }
  assert.equal(config.agents?.defaults?.model?.primary, MODEL, "legacy operator model changed");
  assert.equal(
    fs.readFileSync(
      path.join(
        requiredEnv("OPENCLAW_TEST_WORKSPACE_DIR"),
        "skills",
        "survivor-workspace",
        "SKILL.md",
      ),
      "utf8",
    ),
    SKILL,
    "workspace skill changed",
  );
}

export function assertLegacyOperatorApprovals(stage) {
  const stateDir = requiredEnv("OPENCLAW_STATE_DIR");
  const baseline = readJson(artifact("legacy-operator-baseline.json"));
  const legacyPath = path.join(stateDir, "exec-approvals.json");
  let policy;
  if (stage === "baseline" && baseline.approvalsJsonEra) {
    policy = readJson(legacyPath);
  } else {
    const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
    assert(fs.existsSync(dbPath), "legacy operator approvals database missing");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT raw_json FROM exec_approvals_config WHERE config_key = ?")
        .get("current");
      assert(row, "legacy operator approvals canonical row missing");
      policy = JSON.parse(row.raw_json);
    } finally {
      db.close();
    }
  }
  const observed = stage === "baseline" ? baselinePolicy(policy) : authoredPolicy(policy);
  writeJson(artifact(`legacy-operator-${stage}-approvals.json`), observed);
  assert(isDeepStrictEqual(observed, baseline.approvals), "legacy operator exec approvals changed");
  if (stage !== "baseline") {
    assert(!fs.existsSync(legacyPath), "legacy exec approvals file was not retired");
  }
}

export function assertLegacyOperatorGatewayState(stage) {
  const listing = cli(["cron", "list", "--all", "--json"], `legacy-operator-${stage}-cron`, {
    json: true,
  });
  assertLegacyOperatorCronOwners(listing, readJson(artifact("legacy-operator-baseline.json")));
  console.log("Legacy operator cron owners: survivor-default-owner=main, survivor-ops-owner=ops.");
}

export function assertLegacyOperatorCronOwners(listing, baseline) {
  const seededJobs = listing.jobs?.filter((job) => JOBS.some(({ name }) => job.name === name));
  assert.equal(seededJobs?.length, 2, "legacy operator cron job count changed");
  for (const expected of JOBS) {
    const before = baseline.jobs?.find((job) => job.name === expected.name);
    const after = seededJobs.find((job) => job.id === before?.id && job.name === expected.name);
    assert(after, `legacy operator cron job missing: ${expected.name}`);
    assert.equal(
      after.effectiveAgentId,
      expected.agentId,
      `legacy operator cron owner unresolved or changed: ${expected.name}`,
    );
    assert.equal(
      after.agentId,
      before.agentId,
      `legacy operator cron explicit owner changed: ${expected.name}`,
    );
  }
}

export function runLegacyOperatorTurn(stage) {
  assert(["baseline", "candidate"].includes(stage), "unknown legacy operator turn stage");
  const marker = `OPENCLAW_E2E_LEGACY_OPERATOR_${stage.toUpperCase()}`;
  const label = `legacy-operator-${stage}-turn`;
  const log = artifact("legacy-operator-requests.jsonl");
  const priorBytes = fs.existsSync(log) ? fs.statSync(log).size : 0;
  cli(
    [
      "agent",
      "--agent",
      "main",
      "--session-id",
      `legacy-operator-${stage}`,
      "--message",
      `Reply with exactly ${marker}.`,
      "--thinking",
      "off",
      "--timeout",
      "90",
      "--json",
    ],
    label,
  );
  assertAgentReplyContainsMarker(marker, artifact(`${label}.out`));
  const requests = fs
    .readFileSync(log)
    .subarray(priorBytes)
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(
    requests.some(
      (request) =>
        request.method === "POST" &&
        request.path === "/v1/chat/completions" &&
        JSON.stringify(request.body).includes(marker),
    ),
    `${stage} agent turn did not reach the mock provider with its prompt`,
  );
  console.log(`Legacy operator ${stage} agent turn: ${marker}.`);
}
