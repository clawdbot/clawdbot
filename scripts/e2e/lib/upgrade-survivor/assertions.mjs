import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
// Assertions for upgrade-survivor E2E scenarios.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readPluginInstallIndex } from "../plugin-index-sqlite.mjs";
import { assertUpgradeVolumeMigrated, seedUpgradeVolume } from "./sqlite-volume.mjs";

const command = process.argv[2];
const SCENARIOS = new Set([
  "base",
  "acpx-openclaw-tools-bridge",
  "feishu-channel",
  "bootstrap-persona",
  "channel-post-core-restore",
  "codex-allowlist-survival",
  "plugin-deps-cleanup",
  "configured-plugin-installs",
  "stale-source-plugin-shadow",
  "prerelease-plugin-registry",
  "tilde-log-path",
  "meeting-transcripts-sqlite",
  "versioned-runtime-deps",
  "cron-scheduled-authority",
  "sqlite-volume",
  "auth-profile-v2026-7-2-beta-5",
]);

const PERSONA_FILES = new Map([
  ["BOOTSTRAP.md", "# Existing Bootstrap\n\nDo not overwrite me during update.\n"],
  ["SOUL.md", "# Existing Soul\n\nKeep this voice intact.\n"],
  ["USER.md", "# Existing User\n\nPrefers survivor tests.\n"],
  ["MEMORY.md", "# Existing Memory\n\nUpgrade reports came from real users.\n"],
]);

const LEGACY_SESSION_MAIN_ID = "upgrade-main-session";
const LEGACY_SESSION_DIRECT_ID = "upgrade-direct-session";
const LEGACY_SESSION_GROUP_ID = "upgrade-group-session";
const PLUGIN_DECLARED_SURFACE_GROUPS = [
  "channels",
  "providers",
  "tools",
  "contracts",
  "hooks",
  "mcpServers",
  "cliCommands",
  "cliBackends",
  "skills",
  "dangerousConfigFlags",
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function resolveHomePath(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }
  if (value === "~") {
    return process.env.HOME || value;
  }
  if (value.startsWith("~/")) {
    return path.join(process.env.HOME || "", value.slice(2));
  }
  return value;
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isPathInsideManagedNpmProjectPackageRoot(params) {
  const relative = path.relative(path.join(params.stateDir, "npm", "projects"), params.installPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const segments = relative.split(path.sep);
  const packageSegments = params.packageName.split("/");
  return (
    segments.length === 2 + packageSegments.length &&
    Boolean(segments[0]) &&
    segments[1] === "node_modules" &&
    packageSegments.every((segment, index) => segments[index + 2] === segment)
  );
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function writeJson(file, value) {
  write(file, `${JSON.stringify(value, null, 2)}\n`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function seedLegacySessionMetadata(stateDir) {
  const legacySessionsDir = path.join(stateDir, "sessions");
  const baseUpdatedAt = Date.now() - 24 * 60 * 60 * 1000;
  writeJson(path.join(legacySessionsDir, "sessions.json"), {
    main: {
      sessionId: LEGACY_SESSION_MAIN_ID,
      sessionFile: path.join(legacySessionsDir, `${LEGACY_SESSION_MAIN_ID}.jsonl`),
      provider: "openai",
      model: "gpt-5.5",
      updatedAt: baseUpdatedAt,
      skillsSnapshot: {
        prompt: "legacy prompt survives as metadata",
        resolvedSkills: [
          {
            name: "legacy-heavy-skill-cache",
            filePath: "/tmp/openclaw-old-package/skills/legacy-heavy-skill-cache/SKILL.md",
          },
        ],
      },
    },
    "+15551234567": {
      sessionId: LEGACY_SESSION_DIRECT_ID,
      sessionFile: path.join(legacySessionsDir, `${LEGACY_SESSION_DIRECT_ID}.jsonl`),
      provider: "openai",
      model: "gpt-5.5",
      updatedAt: baseUpdatedAt + 100,
    },
    "slack:channel:CUPGRADE": {
      sessionId: LEGACY_SESSION_GROUP_ID,
      sessionFile: path.join(legacySessionsDir, `${LEGACY_SESSION_GROUP_ID}.jsonl`),
      provider: "openai",
      model: "gpt-5.5",
      updatedAt: baseUpdatedAt + 200,
      lastChannel: "slack",
      lastTo: "CUPGRADE",
    },
  });
  for (const sessionId of [
    LEGACY_SESSION_MAIN_ID,
    LEGACY_SESSION_DIRECT_ID,
    LEGACY_SESSION_GROUP_ID,
  ]) {
    write(
      path.join(legacySessionsDir, `${sessionId}.jsonl`),
      `${JSON.stringify({ type: "session", id: sessionId })}\n`,
    );
  }
}

function seedLegacyMeetingTranscripts(stateDir) {
  const sessionDir = path.join(stateDir, "transcripts", "2026-07-01", "design-review");
  const session = {
    sessionId: "design-review",
    title: "Design review",
    source: { providerId: "manual-transcript" },
    startedAt: "2026-07-01T10:00:00.000Z",
    stoppedAt: "2026-07-01T10:30:00.000Z",
  };
  writeJson(path.join(sessionDir, "metadata.json"), session);
  write(
    path.join(sessionDir, "transcript.jsonl"),
    [
      JSON.stringify({
        id: "legacy-u-1",
        sessionId: session.sessionId,
        speaker: { label: "Alex" },
        text: "First shipped transcript line",
        final: true,
      }),
      JSON.stringify({
        id: "legacy-u-2",
        sessionId: session.sessionId,
        speaker: { label: "Sam" },
        text: "Second shipped transcript line",
        final: true,
      }),
    ].join("\n") + "\n",
  );
  const summary = {
    sessionId: session.sessionId,
    title: session.title,
    generatedAt: "2026-07-01T10:31:00.000Z",
    overview: "First shipped transcript line. Second shipped transcript line.",
    transcript: ["Alex: First shipped transcript line", "Sam: Second shipped transcript line"],
    decisions: [],
    actionItems: [],
    risks: [],
    utteranceCount: 2,
  };
  writeJson(path.join(sessionDir, "summary.json"), summary);
  write(path.join(sessionDir, "summary.md"), "# Design review\n\nShipped transcript summary.\n");
}

function seedLegacyCronScheduledAuthority(stateDir) {
  const createdAtMs = Date.parse("2026-07-01T10:00:00.000Z");
  const base = {
    enabled: true,
    createdAtMs,
    updatedAtMs: createdAtMs,
    schedule: { kind: "every", everyMs: 3_600_000, anchorMs: createdAtMs },
    sessionTarget: "isolated",
    wakeMode: "now",
    delivery: { mode: "none" },
    state: { nextRunAtMs: createdAtMs + 3_600_000 },
  };
  writeJson(path.join(stateDir, "cron", "jobs.json"), {
    version: 1,
    jobs: [
      {
        ...base,
        id: "cron-pre-cap",
        name: "Pre-cap agent job",
        payload: { kind: "agentTurn", message: "pre-cap" },
      },
      {
        ...base,
        id: "cron-ownerless-cap",
        name: "Ownerless capped job",
        payload: { kind: "agentTurn", message: "ownerless", toolsAllow: ["write"] },
      },
      {
        ...base,
        id: "cron-owner-session",
        name: "Persisted owner session",
        owner: {
          agentId: "main",
          sessionKey: "agent:main:discord:group:ops",
        },
        payload: { kind: "agentTurn", message: "owned", toolsAllow: ["write"] },
      },
      {
        ...base,
        id: "cron-encoded-account",
        name: "Encoded owner account",
        owner: {
          agentId: "main",
          sessionKey: "agent:main:discord:personal:direct:user-1",
        },
        payload: { kind: "agentTurn", message: "encoded", toolsAllow: ["write"] },
      },
      {
        ...base,
        id: "cron-agent-mismatch",
        name: "Mismatched owner agent",
        owner: {
          agentId: "other",
          sessionKey: "agent:main:discord:work:direct:user-2",
        },
        payload: { kind: "agentTurn", message: "mismatch", toolsAllow: ["write"] },
      },
    ],
  });
}

function getScenario() {
  const scenario = process.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIO || "base";
  assert(SCENARIOS.has(scenario), `unknown upgrade survivor scenario: ${scenario}`);
  return scenario;
}

function getConfig() {
  return readJson(requireEnv("OPENCLAW_CONFIG_PATH"));
}

function getCoverage() {
  const file = process.env.OPENCLAW_UPGRADE_SURVIVOR_CONFIG_COVERAGE_JSON;
  if (!file || !fs.existsSync(file)) {
    return null;
  }
  return readJson(file);
}

function acceptsIntent(coverage, id) {
  if (!coverage) {
    return true;
  }
  return (
    Array.isArray(coverage.acceptedIntents) &&
    coverage.acceptedIntents.includes(id) &&
    !coverage.skippedIntents?.includes(id)
  );
}

function hasCoverage(coverage) {
  return Boolean(coverage);
}

function seedState() {
  const stateDir = requireEnv("OPENCLAW_STATE_DIR");
  const workspace = requireEnv("OPENCLAW_TEST_WORKSPACE_DIR");
  const scenario = getScenario();

  write(
    path.join(workspace, "IDENTITY.md"),
    "# Upgrade Survivor\n\nThis workspace must survive package update and doctor repair.\n",
  );
  if (scenario === "bootstrap-persona") {
    for (const [fileName, contents] of PERSONA_FILES) {
      write(path.join(workspace, fileName), contents);
    }
  }
  writeJson(path.join(workspace, ".openclaw", "workspace-state.json"), {
    version: 1,
    setupCompletedAt: "2026-04-01T00:00:00.000Z",
  });
  writeJson(path.join(stateDir, "agents", "main", "sessions", "legacy-session.json"), {
    id: "legacy-session",
    agentId: "main",
    title: "Existing user session",
  });
  seedLegacySessionMetadata(stateDir);
  if (scenario === "meeting-transcripts-sqlite") {
    seedLegacyMeetingTranscripts(stateDir);
  }
  if (scenario === "cron-scheduled-authority") {
    seedLegacyCronScheduledAuthority(stateDir);
  }
  if (scenario === "auth-profile-v2026-7-2-beta-5") {
    const fixture = readJson(
      path.join(
        process.cwd(),
        "scripts/e2e/lib/upgrade-survivor/fixtures/auth-profile-v2026.7.2-beta.5.json",
      ),
    );
    assert(fixture.sourceTag === "v2026.7.2-beta.5", "auth profile fixture tag drifted");
    assert(fixture.sourceCommit === "34aefcf2fefa", "auth profile fixture commit drifted");
    assert(fixture.agentSchemaVersion === 15, "auth profile fixture schema drifted");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    writeJson(path.join(agentDir, "auth-profiles.json"), fixture.authProfiles);
    writeJson(path.join(agentDir, "auth-state.json"), fixture.authState);
    writeJson(path.join(agentDir, "auth.json"), fixture.legacyAuth);
    writeJson(path.join(stateDir, "credentials", "oauth.json"), fixture.legacyOAuth);
  }

  const runtimeRoot = path.join(stateDir, "plugin-runtime-deps");
  for (const plugin of ["discord", "telegram", "whatsapp"]) {
    writeJson(path.join(runtimeRoot, plugin, ".openclaw-runtime-deps-stamp.json"), {
      version: 0,
      plugin,
      stale: true,
    });
    write(
      path.join(
        runtimeRoot,
        plugin,
        ".openclaw-runtime-deps-copy-stale",
        "node_modules",
        "stale-sentinel",
        "package.json",
      ),
      `${JSON.stringify({ name: "stale-sentinel", version: "0.0.0" }, null, 2)}\n`,
    );
  }
  if (scenario === "versioned-runtime-deps") {
    const version = process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION || "2026.4.24";
    for (const plugin of ["discord", "feishu", "telegram", "whatsapp"]) {
      writeJson(
        path.join(
          runtimeRoot,
          `openclaw-${version}-${plugin}`,
          ".openclaw-runtime-deps-stamp.json",
        ),
        {
          packageVersion: version,
          plugin,
          stale: true,
        },
      );
      write(
        path.join(
          runtimeRoot,
          `openclaw-${version}-${plugin}`,
          "node_modules",
          "stale-sentinel",
          "package.json",
        ),
        `${JSON.stringify({ name: "stale-sentinel", version: "0.0.0" }, null, 2)}\n`,
      );
    }
  }

  writeJson(path.join(stateDir, "survivor-baseline.json"), {
    agents: ["main", "ops"],
    discordGuild: "222222222222222222",
    discordChannel: "333333333333333333",
    telegramGroup: "-1001234567890",
    whatsappGroup: "120363000000000000@g.us",
    workspaceIdentity: path.join(workspace, "IDENTITY.md"),
    scenario,
  });
}

function assertConfigSurvived() {
  const config = getConfig();
  const coverage = getCoverage();
  const scenario = getScenario();
  if (scenario === "meeting-transcripts-sqlite") {
    // This focused migration fixture proves state import/export across one published
    // baseline; the broad base scenario owns unrelated agent/channel config parity.
    return;
  }

  if (acceptsIntent(coverage, "update")) {
    const expectedChannel = scenario === "prerelease-plugin-registry" ? "beta" : "stable";
    assert(config.update?.channel === expectedChannel, "update.channel was not preserved");
  }
  if (acceptsIntent(coverage, "gateway")) {
    assert(config.gateway?.auth?.mode === "token", "gateway auth mode was not preserved");
  }

  if (acceptsIntent(coverage, "models")) {
    assert(config.models?.providers?.openai, "OpenAI model provider missing");
  }

  if (acceptsIntent(coverage, "agents")) {
    const legacyAgents = config.agents?.list ?? [];
    const mainAgent =
      config.agents?.entries?.main ?? legacyAgents.find((agent) => agent?.id === "main");
    const opsAgent =
      config.agents?.entries?.ops ?? legacyAgents.find((agent) => agent?.id === "ops");
    assert(mainAgent, "main agent missing");
    assert(opsAgent, "ops agent missing");
    if (!hasCoverage(coverage) || !coverage.skippedIntents?.includes("agent-modern-preferences")) {
      assert(opsAgent.fastModeDefault === true, "ops fastModeDefault changed");
    }
  }

  if (acceptsIntent(coverage, "skills")) {
    assert(config.skills?.allowBundled?.includes("memory"), "memory skill allowlist changed");
  }

  if (acceptsIntent(coverage, "plugins")) {
    const pluginAllow = config.plugins?.allow ?? [];
    assert(pluginAllow.includes("discord"), "discord plugin allow entry missing");
    assert(pluginAllow.includes("telegram"), "telegram plugin allow entry missing");
    if (hasCoverage(coverage) && acceptsIntent(coverage, "configured-plugin-installs")) {
      assert(pluginAllow.includes("matrix"), "matrix plugin allow entry missing");
    } else {
      assert(pluginAllow.includes("whatsapp"), "whatsapp plugin allow entry missing");
    }
    if (scenario === "codex-allowlist-survival") {
      assert(pluginAllow.includes("codex"), "Codex plugin allow entry missing");
    }
    if (hasCoverage(coverage) && acceptsIntent(coverage, "feishu-channel")) {
      assert(pluginAllow.includes("feishu"), "feishu plugin allow entry missing");
    }
  }

  if (hasCoverage(coverage) && acceptsIntent(coverage, "acpx-openclaw-tools-bridge")) {
    const pluginAllow = config.plugins?.allow ?? [];
    assert(pluginAllow.includes("acpx"), "ACPX plugin allow entry missing");
    assert(config.plugins?.entries?.acpx?.enabled === true, "ACPX plugin entry changed");
    assert(
      config.plugins?.entries?.acpx?.config?.openClawToolsMcpBridge === true,
      "ACPX OpenClaw tools bridge config changed",
    );
  }

  if (hasCoverage(coverage) && acceptsIntent(coverage, "configured-plugin-installs")) {
    const pluginAllow = config.plugins?.allow ?? [];
    assert(pluginAllow.includes("discord"), "configured install discord allow entry missing");
    assert(pluginAllow.includes("telegram"), "configured install telegram allow entry missing");
    assert(pluginAllow.includes("matrix"), "configured install matrix allow entry missing");
    assert(
      config.plugins?.entries?.matrix?.enabled === true,
      "configured install matrix entry changed",
    );
  }

  if (acceptsIntent(coverage, "discord-channel")) {
    const discord = config.channels?.discord;
    assert(discord?.enabled === true, "discord enabled flag changed");
    const stage = process.env.OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE || "survival";
    const discordAllowFrom =
      stage === "baseline" ? (discord.allowFrom ?? discord.dm?.allowFrom) : discord.allowFrom;
    const discordDmPolicy =
      stage === "baseline" ? (discord.dmPolicy ?? discord.dm?.policy) : discord.dmPolicy;
    if (stage !== "baseline") {
      assert(!Object.hasOwn(discord, "dm"), "legacy Discord DM config survived update");
    }
    assert(discordDmPolicy === "allowlist", "discord DM policy changed");
    assert(
      Array.isArray(discordAllowFrom) && discordAllowFrom.includes("111111111111111111"),
      "discord allowFrom changed",
    );
    assert(
      discord.guilds?.["222222222222222222"]?.channels?.["333333333333333333"]?.requireMention ===
        true,
      "discord guild channel mention policy changed",
    );
    assert(discord.threadBindings?.idleHours === 72, "discord thread binding ttl changed");
  }

  if (acceptsIntent(coverage, "telegram-channel")) {
    const telegram = config.channels?.telegram;
    assert(telegram?.enabled === true, "telegram enabled flag changed");
    assert(
      telegram.groups?.["-1001234567890"]?.requireMention === true,
      "telegram group policy changed",
    );
  }

  if (
    acceptsIntent(coverage, "whatsapp-channel") &&
    !acceptsIntent(coverage, "configured-plugin-installs")
  ) {
    const whatsapp = config.channels?.whatsapp;
    assert(whatsapp?.enabled === true, "whatsapp enabled flag changed");
    const whatsappGroup = whatsapp.groups?.["120363000000000000@g.us"];
    if (hasCoverage(coverage)) {
      assert(whatsappGroup?.requireMention === true, "whatsapp group policy changed");
    } else {
      assert(
        whatsappGroup?.systemPrompt === "Use the existing WhatsApp group prompt.",
        "whatsapp group policy changed",
      );
    }
  }

  if (scenario === "channel-post-core-restore") {
    const whatsapp = config.channels?.whatsapp;
    assert(whatsapp?.enabled === true, "post-core channel restore dropped WhatsApp");
    assert(
      whatsapp.groups?.["120363000000000000@g.us"]?.requireMention === true,
      "post-core channel restore changed WhatsApp group config",
    );
  }

  if (hasCoverage(coverage) && acceptsIntent(coverage, "configured-plugin-installs")) {
    const matrix = config.channels?.matrix;
    assert(matrix?.enabled === true, "matrix enabled flag changed");
    assert(matrix?.homeserver === "https://matrix.example.invalid", "matrix homeserver changed");
    assert(matrix?.userId === "@upgrade-survivor:matrix.example.invalid", "matrix userId changed");
    assert(
      !config.channels?.whatsapp,
      "whatsapp channel config should be absent in matrix scenario",
    );
  }

  if (hasCoverage(coverage) && acceptsIntent(coverage, "feishu-channel")) {
    const feishu = config.channels?.feishu;
    assert(feishu?.enabled === true, "feishu enabled flag changed");
    assert(feishu?.connectionMode === "webhook", "feishu connection mode changed");
    assert(feishu?.defaultAccount === "default", "feishu default account changed");
    assert(feishu?.accounts?.default?.appId === "cli_upgrade_survivor", "feishu account changed");
    assert(
      feishu.groups?.oc_upgrade_survivor?.requireMention === true,
      "feishu group mention policy changed",
    );
  }

  if (hasCoverage(coverage) && acceptsIntent(coverage, "logging")) {
    assert(
      config.logging?.file === "~/openclaw-upgrade-survivor/gateway.jsonl",
      "logging.file tilde path changed",
    );
  }
}

function assertStateSurvived() {
  const stateDir = requireEnv("OPENCLAW_STATE_DIR");
  const workspace = requireEnv("OPENCLAW_TEST_WORKSPACE_DIR");
  const scenario = getScenario();
  const stage = process.env.OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE || "survival";
  assert(fs.existsSync(path.join(workspace, "IDENTITY.md")), "workspace identity file missing");
  assert(
    fs.existsSync(path.join(stateDir, "agents", "main", "sessions", "legacy-session.json")),
    "legacy session file missing",
  );
  if (stage !== "baseline") {
    assertSessionMetadataMigrated(stateDir);
  }
  if (scenario === "meeting-transcripts-sqlite") {
    assertMeetingTranscriptsMigrated(stateDir, stage);
  }
  if (scenario === "cron-scheduled-authority") {
    assertCronScheduledAuthorityMigrated(stateDir, stage);
  }
  if (scenario === "sqlite-volume") {
    assertUpgradeVolumeMigrated(stateDir, stage);
  }
  if (scenario === "auth-profile-v2026-7-2-beta-5") {
    assertAuthProfileMigrationSurvived(stateDir, stage);
  }
  const legacyRuntimeRoot = path.join(stateDir, "plugin-runtime-deps");
  if (stage === "baseline") {
    if (fs.existsSync(legacyRuntimeRoot)) {
      assert(
        fs.existsSync(path.join(legacyRuntimeRoot, "discord")),
        "legacy plugin runtime deps root exists but discord debris is missing before doctor cleanup",
      );
    }
  } else {
    assert(
      !fs.existsSync(legacyRuntimeRoot),
      `legacy plugin runtime deps root survived update/doctor: ${legacyRuntimeRoot}`,
    );
  }
  if (scenario === "bootstrap-persona") {
    for (const [fileName, contents] of PERSONA_FILES) {
      const actual = fs.readFileSync(path.join(workspace, fileName), "utf8");
      assert(actual === contents, `${fileName} was changed during update/doctor`);
    }
  }
  if (scenario === "stale-source-plugin-shadow") {
    const staleRoot = path.join(stateDir, "extensions", "opik-openclaw");
    assert(
      fs.existsSync(path.join(staleRoot, "src", "index.ts")),
      "source-only plugin shadow fixture missing",
    );
  }
  if (scenario === "versioned-runtime-deps") {
    if (stage === "baseline") {
      return;
    }
    const version = process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION || "2026.4.24";
    const runtimeRoot = path.join(stateDir, "plugin-runtime-deps");
    const staleVersionedRoots = fs.existsSync(runtimeRoot)
      ? fs.readdirSync(runtimeRoot).filter((entry) => entry.startsWith(`openclaw-${version}-`))
      : [];
    assert(
      staleVersionedRoots.length === 0,
      `stale versioned runtime deps survived update/doctor: ${staleVersionedRoots.join(", ")}`,
    );
  }
}

function assertAuthProfileMigrationSurvived(stateDir, stage) {
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const sources = [
    path.join(agentDir, "auth-profiles.json"),
    path.join(agentDir, "auth-state.json"),
    path.join(agentDir, "auth.json"),
    path.join(stateDir, "credentials", "oauth.json"),
  ];
  if (stage === "baseline") {
    assert(
      sources.every((source) => fs.existsSync(source)),
      "auth profile fixture source missing",
    );
    return;
  }
  for (const source of sources) {
    assert(!fs.existsSync(source), `legacy auth source remained active: ${source}`);
    const prefix = `${path.basename(source)}.migrated-`;
    const archives = fs
      .readdirSync(path.dirname(source))
      .filter((entry) => entry.startsWith(prefix));
    assert(archives.length === 1, `expected one legacy auth archive for ${source}`);
  }
  const agentDatabase = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"), {
    readOnly: true,
  });
  try {
    const row = agentDatabase
      .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'")
      .get();
    const store = JSON.parse(row?.store_json ?? "null");
    assert(
      store?.profiles?.["openai:default"]?.key === "fake-upgrade-openai-key",
      "openai credential did not migrate",
    );
    assert(
      store?.profiles?.["xai:default"]?.key === "fake-upgrade-xai-key",
      "legacy xai credential did not migrate",
    );
    assert(
      store?.profiles?.["anthropic:default"]?.refresh === "fake-upgrade-refresh-token",
      "shared OAuth credential did not migrate",
    );
  } finally {
    agentDatabase.close();
  }
  const stateDatabase = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    const receipt = stateDatabase
      .prepare(
        "SELECT COUNT(*) AS count FROM migration_sources WHERE migration_kind = ? AND status = 'completed' AND removed_source = 1",
      )
      .get("auth-profile-json-to-sqlite-v2");
    assert(
      receipt?.count === 4,
      `expected four completed auth migration receipts, got ${String(receipt?.count)}`,
    );
  } finally {
    stateDatabase.close();
  }
}

function assertCronScheduledAuthorityMigrated(stateDir, stage) {
  const legacyStorePath = path.join(stateDir, "cron", "jobs.json");
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  if (stage === "baseline") {
    if (fs.existsSync(legacyStorePath)) {
      const jobs = readJson(legacyStorePath).jobs ?? [];
      assert(jobs.length === 5, "legacy cron authority fixture row count changed before update");
      return;
    }
    assert(fs.existsSync(databasePath), "legacy cron authority fixture missing before update");
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT job_json FROM cron_jobs WHERE job_id LIKE 'cron-%'").all();
      assert(rows.length === 5, "baseline cron authority fixture row count changed");
      assert(
        rows.every((row) => JSON.parse(row.job_json).scheduledToolPolicy === undefined),
        "baseline unexpectedly authored current scheduled authority provenance",
      );
    } finally {
      db.close();
    }
    return;
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT job_id, job_json FROM cron_jobs WHERE job_id LIKE 'cron-%'")
      .all();
    const jobs = new Map(rows.map((row) => [row.job_id, JSON.parse(row.job_json)]));
    assert(jobs.size === 5, `cron authority fixture row count changed: ${jobs.size}`);
    assert(
      jobs.get("cron-encoded-account")?.scheduledToolPolicy?.ownerAccountId === "personal",
      "session-encoded account authority was not recovered",
    );
    assert(
      jobs.get("cron-encoded-account")?.owner?.accountId === "personal",
      "session-encoded account was not projected onto the owner",
    );
    for (const id of [
      "cron-pre-cap",
      "cron-ownerless-cap",
      "cron-owner-session",
      "cron-agent-mismatch",
    ]) {
      assert(
        jobs.get(id)?.scheduledToolPolicy === undefined,
        `ambiguous legacy job unexpectedly gained scheduled authority: ${id}`,
      );
    }
  } finally {
    db.close();
  }
}

function assertMeetingTranscriptsMigrated(stateDir, stage) {
  const legacySessionDir = path.join(stateDir, "transcripts", "2026-07-01", "design-review");
  if (stage === "baseline") {
    assert(
      fs.existsSync(path.join(legacySessionDir, "transcript.jsonl")),
      "v2026.7.1 meeting transcript fixture missing before update",
    );
    return;
  }

  assert(!fs.existsSync(legacySessionDir), "legacy meeting transcript source was not archived");
  const archiveRoot = fs
    .readdirSync(stateDir)
    .find((entry) => entry.startsWith("transcripts.migrated-"));
  assert(archiveRoot, "meeting transcript migration archive missing");
  assert(
    fs.existsSync(
      path.join(stateDir, archiveRoot, "2026-07-01", "design-review", "transcript.jsonl"),
    ),
    "archived meeting transcript JSONL missing",
  );

  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const session = db
      .prepare(
        "SELECT session_id, started_at, next_utterance_seq FROM meeting_transcript_sessions WHERE session_id = ?",
      )
      .get("design-review");
    assert(session?.started_at === "2026-07-01T10:00:00.000Z", "meeting session row missing");
    assert(session?.next_utterance_seq === 2, "meeting transcript sequence head changed");
    const utterances = db
      .prepare(
        "SELECT sequence, utterance_id, text FROM meeting_transcript_utterances WHERE session_id = ? ORDER BY sequence ASC",
      )
      .all("design-review");
    assert(
      JSON.stringify(utterances) ===
        JSON.stringify([
          {
            sequence: 0,
            utterance_id: "legacy-u-1",
            text: "First shipped transcript line",
          },
          {
            sequence: 1,
            utterance_id: "legacy-u-2",
            text: "Second shipped transcript line",
          },
        ]),
      "meeting transcript utterance ordering changed",
    );
    const receipt = db
      .prepare(
        "SELECT status, removed_source, source_record_count FROM migration_sources WHERE migration_kind = ?",
      )
      .get("meeting-transcripts-files-v1");
    assert(receipt?.status === "archived", "meeting transcript migration receipt incomplete");
    assert(receipt?.removed_source === 1, "meeting transcript source removal was not recorded");
    assert(receipt?.source_record_count === 2, "meeting transcript receipt count changed");
  } finally {
    db.close();
  }

  const exportedDir = execFileSync(
    "openclaw",
    ["transcripts", "path", "2026-07-01/design-review", "--dir"],
    { encoding: "utf8", env: process.env },
  ).trim();
  assert(exportedDir === legacySessionDir, "meeting transcript export path changed");
  const exportedLines = fs
    .readFileSync(path.join(exportedDir, "transcript.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(exportedLines[0]?.id === "legacy-u-1", "first exported utterance changed");
  assert(exportedLines[1]?.id === "legacy-u-2", "second exported utterance changed");
  assert(
    fs
      .readFileSync(path.join(exportedDir, "summary.md"), "utf8")
      .includes("Shipped transcript summary"),
    "summary.md was not materialized from SQLite",
  );
}

function assertSessionMetadataMigrated(stateDir) {
  const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
  const agentSessionsDir = path.join(stateDir, "agents", "main", "sessions");
  const targetStorePath = path.join(agentSessionsDir, "sessions.json");
  assert(
    !fs.existsSync(legacyStorePath),
    `legacy sessions.json survived migration: ${legacyStorePath}`,
  );

  const { source, store } = readMigratedSessionStore(stateDir, targetStorePath);
  const main = store["agent:main:main"];
  const direct = store["agent:main:+15551234567"];
  const group = store["agent:main:slack:channel:cupgrade"];
  assert(main?.sessionId === LEGACY_SESSION_MAIN_ID, "main legacy session row missing");
  assert(direct?.sessionId === LEGACY_SESSION_DIRECT_ID, "direct legacy session row missing");
  assert(group?.sessionId === LEGACY_SESSION_GROUP_ID, "channel legacy session row missing");
  const migratedSessions = [
    [LEGACY_SESSION_MAIN_ID, main],
    [LEGACY_SESSION_DIRECT_ID, direct],
    [LEGACY_SESSION_GROUP_ID, group],
  ];
  for (const [sessionId, entry] of migratedSessions) {
    assert(
      !Object.hasOwn(entry ?? {}, "sessionFile"),
      `legacy session row retained retired sessionFile metadata for ${sessionId}`,
    );
  }
  if (source !== "file") {
    const dbPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const count = db.prepare(
        "SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?",
      );
      for (const [sessionId] of migratedSessions) {
        const row = count.get(sessionId);
        assert(
          Number(row?.count ?? 0) > 0,
          `legacy session transcript was not imported for ${sessionId}`,
        );
      }
    } finally {
      db.close();
    }
  } else {
    for (const [sessionId] of migratedSessions) {
      const expectedPath = path.join(agentSessionsDir, `${sessionId}.jsonl`);
      assert(
        fs.existsSync(expectedPath),
        `legacy session transcript was not moved for ${sessionId}`,
      );
    }
  }
  assert(
    main.skillsSnapshot?.prompt === "legacy prompt survives as metadata",
    "legacy session metadata prompt was not preserved",
  );
  assert(
    main.skillsSnapshot?.resolvedSkills === undefined,
    "heavy resolvedSkills cache was persisted into migrated session metadata",
  );
}

function readMigratedSessionStore(stateDir, targetStorePath) {
  const dbPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  if (fs.existsSync(dbPath)) {
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const tables = new Set(
        db
          .prepare(
            `SELECT name
             FROM sqlite_master
             WHERE type = 'table'
               AND name IN ('session_nodes', 'session_entries', 'cache_entries')`,
          )
          .all()
          .map((row) => row.name),
      );
      // SQLite is authoritative once it owns a supported session table. A stale
      // sessions.json must not hide missing, malformed, or unreadable database state.
      const source = tables.has("session_nodes")
        ? "session_nodes"
        : tables.has("session_entries")
          ? "session_entries"
          : tables.has("cache_entries")
            ? "cache_entries"
            : null;
      if (source) {
        const rows =
          source === "session_nodes"
            ? db
                .prepare(
                  `SELECT session_key AS key, current_session_id AS session_id, entry_json AS value_json
                   FROM session_nodes`,
                )
                .all()
            : source === "session_entries"
              ? db
                  .prepare(
                    `SELECT session_key AS key, session_id, entry_json AS value_json
                     FROM session_entries`,
                  )
                  .all()
              : db
                  .prepare("SELECT key, value_json FROM cache_entries WHERE scope = ?")
                  .all("session_entries");
        const store = {};
        for (const row of rows) {
          if (typeof row?.key !== "string" || typeof row?.value_json !== "string") {
            continue;
          }
          const entry = JSON.parse(row.value_json);
          store[row.key] =
            typeof row.session_id === "string" ? { ...entry, sessionId: row.session_id } : entry;
        }
        return { source, store };
      }
    } finally {
      db?.close();
    }
  }

  assert(
    fs.existsSync(targetStorePath),
    `agent session store missing: ${targetStorePath} or ${dbPath}`,
  );
  return { source: "file", store: readJson(targetStorePath) };
}

function readInstalledPluginIndex() {
  const stateDir = requireEnv("OPENCLAW_STATE_DIR");
  const index = readPluginInstallIndex({ stateDir });
  assert(index.installRecords, "installed plugin index missing");
  return index;
}

function assertExternalPluginInstall(records, pluginId, packageName) {
  const record = records[pluginId];
  assert(record, `configured external ${pluginId} plugin install record missing`);
  const installedFromNpm = record.source === "npm";
  const installedFromOfficialClawHubNpmPack =
    record.source === "clawhub" &&
    record.clawhubChannel === "official" &&
    record.artifactKind === "npm-pack";
  assert(
    installedFromNpm || installedFromOfficialClawHubNpmPack,
    `configured external ${pluginId} plugin must be installed from npm or official ClawHub npm-pack, got: ${record.source}`,
  );
  const installPath = resolveHomePath(record.installPath);
  assert(
    installPath,
    `configured external ${pluginId} plugin installPath missing: ${JSON.stringify(record)}`,
  );
  assert(
    fs.existsSync(installPath),
    `configured external ${pluginId} plugin installPath missing on disk: ${installPath}`,
  );
  assert(
    fs.existsSync(path.join(installPath, "package.json")),
    `configured external ${pluginId} plugin package.json missing: ${installPath}`,
  );
  const packageJson = readJson(path.join(installPath, "package.json"));
  assert(
    packageJson.name === packageName,
    `configured external ${pluginId} package name changed: ${packageJson.name}`,
  );
  if (installedFromNpm) {
    const stateDir = requireEnv("OPENCLAW_STATE_DIR");
    assert(
      isPathInsideManagedNpmProjectPackageRoot({ stateDir, installPath, packageName }),
      `configured external ${pluginId} npm install path outside managed npm project root: ${installPath}`,
    );
    assert(
      String(record.spec ?? record.resolvedSpec ?? "").startsWith(packageName),
      `configured external ${pluginId} plugin npm spec changed`,
    );
    return packageJson;
  }
  assert(
    record.clawhubPackage === packageName,
    `configured external ${pluginId} ClawHub package changed: ${record.clawhubPackage}`,
  );
  const extensionsRoot = path.join(requireEnv("OPENCLAW_STATE_DIR"), "extensions");
  assert(
    isPathInside(extensionsRoot, installPath),
    `configured external ${pluginId} ClawHub install path outside managed extensions root: ${installPath}`,
  );
  return packageJson;
}

function pluginInstallIntegrity(record) {
  return record.integrity ?? record.npmIntegrity ?? record.clawpackSha256 ?? record.gitCommit;
}

function acceptedSurfaceHash(surface) {
  const canonical = Object.fromEntries(
    PLUGIN_DECLARED_SURFACE_GROUPS.map((group) => [group, surface[group].toSorted()]),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function assertCompanionPluginConsent(record, pluginId, integrity) {
  assert(
    record.acceptedSurface && typeof record.acceptedSurface === "object",
    `${pluginId} plugin accepted surface missing`,
  );
  for (const group of PLUGIN_DECLARED_SURFACE_GROUPS) {
    assert(
      Array.isArray(record.acceptedSurface[group]),
      `${pluginId} plugin accepted surface ${group} missing`,
    );
  }
  assert(
    record.acceptedSurfaceHash === acceptedSurfaceHash(record.acceptedSurface),
    `${pluginId} plugin consent hash changed`,
  );
  assert(
    record.acceptedSurfaceIntegrity === integrity,
    `${pluginId} plugin consent integrity changed`,
  );
  assert(
    typeof record.acceptedSurfaceAt === "string" &&
      Number.isFinite(Date.parse(record.acceptedSurfaceAt)),
    `${pluginId} plugin consent timestamp missing`,
  );
}

function assertCompanionPluginInstalls([expectedVersion, capabilityConsentSupported]) {
  assert(expectedVersion, "assert-companion-installs requires <expected-version>");
  assert(
    capabilityConsentSupported === "0" || capabilityConsentSupported === "1",
    "assert-companion-installs requires candidate capability-consent support",
  );
  const records = readInstalledPluginIndex().installRecords ?? {};
  for (const [pluginId, packageName, source] of [
    ["discord", "@openclaw/discord", "npm"],
    ["whatsapp", "@openclaw/whatsapp", "clawhub"],
    ["codex", "@openclaw/codex", "npm"],
  ]) {
    const packageJson = assertExternalPluginInstall(records, pluginId, packageName);
    const record = records[pluginId];
    assert(record.source === source, `${pluginId} plugin source changed: ${record.source}`);
    const installedVersion = source === "clawhub" ? record.version : record.resolvedVersion;
    assert(
      installedVersion === expectedVersion,
      `${pluginId} plugin version changed: ${String(installedVersion)}`,
    );
    assert(
      packageJson.version === expectedVersion,
      `${pluginId} installed package version changed: ${String(packageJson.version)}`,
    );
    const integrity = pluginInstallIntegrity(record);
    assert(
      typeof integrity === "string" && integrity.length > 0,
      `${pluginId} plugin integrity missing`,
    );
    if (capabilityConsentSupported === "1") {
      assertCompanionPluginConsent(record, pluginId, integrity);
    }
  }
}

function assertConfiguredPluginInstalls() {
  const coverage = getCoverage();
  const stage = process.env.OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE || "survival";
  if (!hasCoverage(coverage) || !acceptsIntent(coverage, "configured-plugin-installs")) {
    return;
  }
  if (stage === "baseline") {
    return;
  }
  const index = readInstalledPluginIndex();
  const records = index.installRecords ?? {};
  assertOptionalConfiguredPluginIndex(records, index.plugins ?? [], {
    bundled: true,
    packageName: "@openclaw/matrix",
    pluginId: "matrix",
  });
  assertOptionalConfiguredPluginIndex(records, index.plugins ?? [], {
    packageName: "@openclaw/brave-plugin",
    pluginId: "brave",
  });
  assert(!records.telegram, "internal telegram plugin should not be installed externally");
}

function assertOptionalConfiguredPluginIndex(
  records,
  plugins,
  { bundled = false, packageName, pluginId },
) {
  const record = records[pluginId];
  const plugin = plugins.find((entry) => entry?.pluginId === pluginId);
  if (record) {
    assertExternalPluginInstall(records, pluginId, packageName);
  }
  if (plugin) {
    assert(
      plugin.enabled !== false,
      `configured ${bundled ? "bundled" : "external"} ${pluginId} plugin is disabled`,
    );
  }
}

function assertStatusJson([file]) {
  const status = readJson(file);
  assert(status && typeof status === "object", "gateway status JSON was not an object");
  const text = JSON.stringify(status);
  assert(/running|connected|ok|ready/u.test(text), "gateway status did not report a healthy state");
}

function parseStableVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/u.exec(version ?? "");
  assert(match, `invalid stable package version: ${String(version)}`);
  return match.slice(1).map((part) => Number(part ?? 0));
}

function compareStableVersions(left, right) {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function normalizeSystemctlInvocation(line) {
  const parts = String(line ?? "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const normalized = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (["--user", "--quiet", "--no-page", "--no-pager", "--now"].includes(part)) {
      continue;
    }
    if (part === "--property") {
      index += 1;
      continue;
    }
    normalized.push(part);
  }
  return normalized.join(" ");
}

function assertUpdateRunSelfUpgrade([file]) {
  assert(file, "assert-update-run-self-upgrade requires a summary path");
  const summary = readJson(file);
  const sourceVersion = summary?.source?.version;
  const targetVersion = summary?.target?.resolvedVersion;
  const updateRpc = summary?.updateRpcResult;
  const sentinel = summary?.restartSentinel;
  const qaChannelInstallRecord = summary?.qaChannelInstallRecord;
  const targetQaChannelInstallRecord = summary?.targetPluginIndex?.installRecords?.["qa-channel"];
  const gatewayStatus = summary?.gateway?.status;
  const qaAccounts = summary?.qaChannel?.status?.channelAccounts?.["qa-channel"];
  const targetServiceStarts = (summary?.supervisorHandoff?.systemctlInvocations ?? [])
    .map(normalizeSystemctlInvocation)
    .filter((invocation) => invocation === "start openclaw-gateway.service");

  assert(summary?.status === "passed", "update.run self-upgrade summary did not pass");
  assert(sourceVersion === "2026.4.26", `unexpected source version: ${String(sourceVersion)}`);
  assert(summary?.source?.spec === "openclaw@2026.4.26", "source package spec was not exact");
  assert(summary?.target?.tag === "latest", "target tag was not latest");
  assert(
    compareStableVersions(targetVersion, sourceVersion) > 0,
    `target version did not advance beyond source: ${String(sourceVersion)} -> ${String(targetVersion)}`,
  );
  assert(
    summary?.installedVersion === targetVersion,
    `installed version mismatch: expected ${String(targetVersion)}, got ${String(summary?.installedVersion)}`,
  );
  assert(qaChannelInstallRecord?.source === "path", "QA channel was not path-installed");
  assert(
    typeof qaChannelInstallRecord?.sourcePath === "string" &&
      qaChannelInstallRecord.sourcePath.includes("/extensions/qa-channel"),
    "QA channel install record omitted its source path",
  );
  assert(
    typeof qaChannelInstallRecord?.installPath === "string" &&
      qaChannelInstallRecord.installPath.includes("/dist/extensions/qa-channel"),
    "QA channel install record omitted its compiled local install path",
  );
  assert(
    qaChannelInstallRecord?.version === "2026.4.25",
    "QA channel install record version mismatch",
  );
  assert(
    summary?.sourcePluginInspect?.plugin?.status === "loaded",
    "source package did not load the compiled QA channel plugin",
  );
  assert(
    targetQaChannelInstallRecord?.source === "path" &&
      targetQaChannelInstallRecord?.installPath === qaChannelInstallRecord?.installPath,
    "target SQLite index did not preserve the QA channel path install record",
  );

  assert(updateRpc?.ok === true, `update.run RPC did not report ok: ${JSON.stringify(updateRpc)}`);
  assert(updateRpc?.result?.status === "ok", "update.run did not execute the package update");
  assert(
    updateRpc?.result?.before?.version === sourceVersion,
    "update.run source version mismatch",
  );
  assert(updateRpc?.result?.after?.version === targetVersion, "update.run target version mismatch");
  assert(
    Array.isArray(updateRpc?.result?.steps) && updateRpc.result.steps.length > 0,
    "update.run reported no executed update steps",
  );
  assert(updateRpc?.restart, "update.run did not schedule a Gateway restart");
  assert(
    updateRpc?.sentinel?.payload?.message === summary.expectedRestartNote,
    "update.run response sentinel note mismatch",
  );

  assert(sentinel?.kind === "update", "final restart sentinel kind was not update");
  assert(sentinel?.status === "ok", "final restart sentinel did not report ok");
  assert(sentinel?.message === summary.expectedRestartNote, "final restart sentinel note mismatch");
  assert(
    sentinel?.stats?.before?.version === sourceVersion,
    "restart sentinel source version mismatch",
  );
  assert(
    sentinel?.stats?.after?.version === targetVersion,
    "restart sentinel target version mismatch",
  );
  assert(
    Number.isSafeInteger(summary?.supervisorHandoff?.servicePid) &&
      summary.supervisorHandoff.servicePid > 1,
    "supervisor handoff did not record the target service PID",
  );
  assert(targetServiceStarts.length === 1, "systemctl shim did not start the target exactly once");
  assert(
    summary?.supervisorHandoff?.monitorEvents?.some((line) =>
      line.includes("source Gateway exited through supervised update handoff"),
    ),
    "supervisor monitor did not prove the source supervised handoff",
  );

  assert(
    summary?.gateway?.healthz?.body?.ok === true &&
      summary?.gateway?.healthz?.body?.status === "live",
    "post-restart /healthz was not live",
  );
  assert(summary?.gateway?.readyz?.body?.ready === true, "post-restart /readyz was not ready");
  assert(
    gatewayStatus?.rpc?.ok === true &&
      gatewayStatus?.rpc?.version === targetVersion &&
      gatewayStatus?.gateway?.version === targetVersion &&
      gatewayStatus?.cli?.version === targetVersion,
    `post-restart Gateway did not report target version ${String(targetVersion)}`,
  );
  assert(Array.isArray(qaAccounts), "post-restart channels.status omitted qa-channel");
  assert(
    qaAccounts.some((account) => account?.running === true && account?.restartPending !== true),
    "post-restart QA channel account was not running",
  );
  assert(
    Number(summary?.qaChannel?.busPollsAfterRestart) > 0,
    "QA channel did not poll its bus after the target Gateway restart",
  );
}

if (command === "list-scenarios") {
  process.stdout.write(`${JSON.stringify([...SCENARIOS])}\n`);
} else if (command === "seed") {
  seedState();
} else if (command === "seed-volume") {
  assert(getScenario() === "sqlite-volume", "seed-volume requires the sqlite-volume scenario");
  const stateDir = requireEnv("OPENCLAW_STATE_DIR");
  seedUpgradeVolume(stateDir);
} else if (command === "assert-config") {
  assertConfigSurvived();
} else if (command === "assert-state") {
  assertStateSurvived();
  assertConfiguredPluginInstalls();
} else if (command === "assert-companion-installs") {
  assertCompanionPluginInstalls(process.argv.slice(3));
} else if (command === "assert-status-json") {
  assertStatusJson(process.argv.slice(3));
} else if (command === "assert-update-run-self-upgrade") {
  assertUpdateRunSelfUpgrade(process.argv.slice(3));
} else {
  throw new Error(`unknown upgrade-survivor assertion command: ${command ?? "<missing>"}`);
}
