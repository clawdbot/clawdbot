// Upgrade Survivor Assertions tests cover upgrade survivor assertions script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const ASSERTIONS_PATH = "scripts/e2e/lib/upgrade-survivor/assertions.mjs";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const RECOVERABLE_UPDATE = {
  status: "error",
  mode: "npm",
  reason: "post-update-plugins",
  before: { version: "2026.7.1-2" },
  after: { version: "2026.8.1" },
  steps: [
    { name: "global update", exitCode: 0 },
    { name: "global install swap", exitCode: 0 },
    { name: "openclaw doctor", exitCode: 0 },
  ],
  postUpdate: {
    plugins: {
      status: "error",
      changed: false,
      reason: "post-plugin-doctor-invalid-config",
      warnings: [
        {
          reason:
            'Plugin "discord" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.',
          message:
            'Plugin "discord" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.',
        },
        {
          reason: "Config remained invalid after updated plugin migrations.",
          message:
            "Post-update plugin migration did not produce a valid config; refusing to restart.",
        },
      ],
      sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
      npm: { changed: false, outcomes: [] },
      integrityDrifts: [],
    },
  },
};

function runJsonAssertion(command: string, value: unknown, ...args: string[]) {
  return runJsonTextAssertion(command, `${JSON.stringify(value, null, 2)}\n`, ...args);
}

function runJsonTextAssertion(command: string, contents: string, ...args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-json-"));
  const file = join(root, "result.json");
  writeFileSync(file, contents);
  const result = spawnSync(
    process.execPath,
    [
      ASSERTIONS_PATH,
      command,
      file,
      ...args,
      ...(command === "assert-recoverable-update-json" ? ["", "2026.7.1-2"] : []),
    ],
    {
      encoding: "utf8",
    },
  );
  rmSync(root, { force: true, recursive: true });
  return result;
}

function runPrefixedJsonAssertion(command: string, value: unknown, ...args: string[]) {
  return runJsonTextAssertion(
    command,
    `Stopped legacy service before update\n${JSON.stringify(value)}\n`,
    ...args,
  );
}

function withPluginResult(patch: Record<string, unknown>) {
  return {
    ...RECOVERABLE_UPDATE,
    postUpdate: { plugins: { ...RECOVERABLE_UPDATE.postUpdate.plugins, ...patch } },
  };
}

describe("upgrade recovery result assertions", () => {
  it("recovers consent warnings emitted after a historical successful core update", () => {
    const core = {
      status: "ok",
      mode: "npm",
      before: { version: "2026.7.1-2" },
      after: { version: "2026.8.1" },
      steps: [
        { name: "global update", exitCode: 0 },
        { name: "openclaw doctor", exitCode: 0 },
      ],
    };
    const plugins = {
      ...RECOVERABLE_UPDATE.postUpdate.plugins,
      status: "warning",
      reason: undefined,
      warnings: [RECOVERABLE_UPDATE.postUpdate.plugins.warnings[0]],
    };
    const continuation = { status: "ok", mode: "unknown", steps: [], postUpdate: { plugins } };
    const output = `${JSON.stringify(core, null, 2)}\n${JSON.stringify(continuation, null, 2)}\n`;
    expect(runJsonTextAssertion("assert-recoverable-update-json", output, "2026.8.1").status).toBe(
      0,
    );
    expect(
      runJsonTextAssertion("assert-successful-update-json", output, "2026.8.1").status,
    ).not.toBe(0);
    expect(
      runJsonAssertion(
        "assert-recoverable-update-json",
        { ...core, postUpdate: { plugins } },
        "2026.8.1",
      ).status,
    ).toBe(0);
    // April 23 prints only the core report; the candidate's complete child result
    // must remain tied to this invocation before it can authorize fixture recovery.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "openclaw-upgrade-capture-")));
    const observationRoot = join(root, "observation");
    const resultFile = join(root, "update.json");
    mkdirSync(join(observationRoot, "diagnostics"), { recursive: true });
    writeJson(resultFile, core);
    const snapshot = { artifactRoot: observationRoot, childExitCode: 0, result: plugins };
    const captured = (command: string, value: unknown) => {
      writeJson(join(observationRoot, "diagnostics", "post-core.json"), value);
      return spawnSync(
        process.execPath,
        [ASSERTIONS_PATH, command, resultFile, "2026.8.1", observationRoot, "2026.7.1-2"],
        { encoding: "utf8" },
      );
    };
    try {
      const recovery = captured("assert-recoverable-update-json", snapshot);
      expect(recovery.status, recovery.stderr).toBe(0);
      expect(captured("assert-successful-update-json", snapshot).status).not.toBe(0);
      for (const invalid of [
        { ...snapshot, artifactRoot: join(root, "previous-update") },
        { ...snapshot, childExitCode: 1 },
        { ...snapshot, result: { ...plugins, status: "error" } },
        {
          ...snapshot,
          result: { ...plugins, sync: { ...plugins.sync, errors: ["registry unavailable"] } },
        },
      ]) {
        expect(captured("assert-recoverable-update-json", invalid).status).not.toBe(0);
        expect(captured("assert-successful-update-json", invalid).status).not.toBe(0);
      }
      writeJson(resultFile, {
        ...core,
        postUpdate: { plugins: { ...plugins, status: "error", reason: "registry-unavailable" } },
      });
      expect(captured("assert-recoverable-update-json", snapshot).status).not.toBe(0);
      expect(captured("assert-successful-update-json", snapshot).status).not.toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
    for (const invalid of [
      { ...continuation, status: "error", reason: "doctor-failed" },
      { ...continuation, steps: [{ name: "doctor", exitCode: 1 }] },
      {
        ...continuation,
        postUpdate: { plugins: { ...plugins, sync: { errors: ["registry unavailable"] } } },
      },
      {
        ...continuation,
        postUpdate: {
          plugins: {
            ...plugins,
            warnings: [...plugins.warnings, { reason: "unrelated plugin failure" }],
          },
        },
      },
    ]) {
      const invalidOutput = `${JSON.stringify(core, null, 2)}\n${JSON.stringify(invalid, null, 2)}\n`;
      expect(
        runJsonTextAssertion("assert-recoverable-update-json", invalidOutput, "2026.8.1").status,
      ).not.toBe(0);
      expect(
        runJsonTextAssertion("assert-successful-update-json", invalidOutput, "2026.8.1").status,
      ).not.toBe(0);
    }
    expect(
      runJsonTextAssertion("assert-recoverable-update-json", output.slice(0, -4), "2026.8.1")
        .status,
    ).not.toBe(0);
  });

  it("accepts historical split successful reports without assuming consent support", () => {
    const core = {
      status: "ok",
      mode: "npm",
      after: { version: "2026.6.35" },
      steps: [{ name: "global update", exitCode: 0 }],
    };
    const continuation = {
      status: "ok",
      mode: "unknown",
      steps: [],
      postUpdate: { plugins: { status: "ok" } },
    };
    const output = `${JSON.stringify(core, null, 2)}\n${JSON.stringify(continuation, null, 2)}\n`;
    expect(runJsonTextAssertion("assert-successful-update-json", output, "2026.6.35").status).toBe(
      0,
    );
  });

  it("accepts clean updates for baselines that already have consent", () => {
    const result = {
      status: "ok",
      after: { version: "2026.8.1" },
      steps: [{ name: "global update", exitCode: 0 }],
    };
    expect(runJsonAssertion("assert-successful-update-json", result, "2026.8.1").status).toBe(0);
    expect(
      runJsonAssertion(
        "assert-successful-update-json",
        {
          ...result,
          steps: [{ name: "global update", exitCode: 1 }],
        },
        "2026.8.1",
      ).status,
    ).not.toBe(0);
    expect(
      runPrefixedJsonAssertion("assert-successful-update-json", result, "2026.8.1").status,
    ).toBe(0);
  });

  it("accepts only a completed core swap stranded on capability consent", () => {
    expect(
      runPrefixedJsonAssertion("assert-recoverable-update-json", RECOVERABLE_UPDATE, "2026.8.1")
        .status,
    ).toBe(0);
    const consentError =
      'Plugin "discord" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.';
    const consentOutcome = {
      pluginId: "discord",
      status: "error",
      code: "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
    };
    const validResults = [
      RECOVERABLE_UPDATE,
      withPluginResult({ warnings: [], sync: { errors: [consentError] } }),
      withPluginResult({ warnings: [], npm: { outcomes: [consentOutcome] } }),
    ];
    for (const value of validResults) {
      expect(runJsonAssertion("assert-recoverable-update-json", value, "2026.8.1").status).toBe(0);
    }

    const invalidResults = [
      { ...RECOVERABLE_UPDATE, reason: "global-update-failed" },
      { ...RECOVERABLE_UPDATE, after: { version: "2026.7.1-2" } },
      {
        ...RECOVERABLE_UPDATE,
        steps: RECOVERABLE_UPDATE.steps.map((step, index) =>
          index === 0 ? { ...step, exitCode: 1 } : step,
        ),
      },
      { ...RECOVERABLE_UPDATE, postUpdate: { plugins: { reason: "registry-timeout" } } },
      withPluginResult({ sync: { errors: [consentError, "registry unavailable"] } }),
      withPluginResult({ npm: { outcomes: [{ status: "error", code: "EIO" }] } }),
      withPluginResult({ integrityDrifts: [{ pluginId: "discord" }] }),
      ...["sync", "npm", "integrityDrifts"].map((field) =>
        withPluginResult({ [field]: undefined }),
      ),
    ];
    for (const value of invalidResults) {
      expect(runJsonAssertion("assert-recoverable-update-json", value, "2026.8.1").status).not.toBe(
        0,
      );
    }
  });

  it("requires repair to finish doctor and plugin convergence without restart", () => {
    const repaired = {
      status: "ok",
      mode: "finalize",
      restart: false,
      postUpdate: { doctor: { status: "ok" }, plugins: { status: "ok" } },
    };
    expect(runJsonAssertion("assert-repair-json", repaired).status).toBe(0);
    expect(
      runJsonAssertion("assert-repair-json", {
        ...repaired,
        postUpdate: { ...repaired.postUpdate, plugins: { status: "warning" } },
      }).status,
    ).not.toBe(0);
  });
});

function writeMigratedSessionState(stateDir: string): void {
  const agentSessionsDir = join(stateDir, "agents", "main", "sessions");
  const agentDbDir = join(stateDir, "agents", "main", "agent");
  mkdirSync(agentSessionsDir, { recursive: true });
  mkdirSync(agentDbDir, { recursive: true });

  const db = new DatabaseSync(join(agentDbDir, "openclaw-agent.sqlite"));
  try {
    db.exec(`
      CREATE TABLE session_nodes (
        session_key TEXT PRIMARY KEY,
        current_session_id TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_windows (
        session_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE transcript_events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq),
        FOREIGN KEY (session_id) REFERENCES session_windows(session_id) ON DELETE CASCADE
      );
    `);
    const insertSession = db.prepare(`
      INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    const insertEntry = db.prepare(`
      INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    const insertTranscript = db.prepare(`
      INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const migratedSessions = [
      {
        entry: {
          skillsSnapshot: {
            prompt: "legacy prompt survives as metadata",
          },
        },
        sessionId: "upgrade-main-session",
        sessionKey: "agent:main:main",
      },
      {
        entry: {},
        sessionId: "upgrade-direct-session",
        sessionKey: "agent:main:+15551234567",
      },
      {
        entry: {},
        sessionId: "upgrade-group-session",
        sessionKey: "agent:main:slack:channel:cupgrade",
      },
    ];
    for (const { entry, sessionId, sessionKey } of migratedSessions) {
      insertSession.run(sessionId, sessionKey, 1710000000000, 1710000000000);
      insertEntry.run(sessionKey, sessionId, JSON.stringify(entry), 1710000000000);
      insertTranscript.run(
        sessionId,
        1,
        JSON.stringify({ type: "session", id: sessionId }),
        1710000000000,
      );
    }
  } finally {
    db.close();
  }
}

function createMigratedSessionFileStore(
  options: { includePrompt?: boolean } = {},
): Record<string, Record<string, unknown>> {
  const main: Record<string, unknown> = { sessionId: "upgrade-main-session" };
  if (options.includePrompt !== false) {
    main.skillsSnapshot = {
      prompt: "legacy prompt survives as metadata",
    };
  }
  return {
    "agent:main:main": main,
    "agent:main:+15551234567": { sessionId: "upgrade-direct-session" },
    "agent:main:slack:channel:cupgrade": { sessionId: "upgrade-group-session" },
  };
}

function writeMigratedSessionFiles(
  stateDir: string,
  options: { includePrompt?: boolean } = {},
): void {
  const agentSessionsDir = join(stateDir, "agents", "main", "sessions");
  mkdirSync(agentSessionsDir, { recursive: true });
  writeJson(join(agentSessionsDir, "sessions.json"), createMigratedSessionFileStore(options));
  for (const sessionId of [
    "upgrade-main-session",
    "upgrade-direct-session",
    "upgrade-group-session",
  ]) {
    writeFileSync(
      join(agentSessionsDir, `${sessionId}.jsonl`),
      `${JSON.stringify({ type: "session", id: sessionId })}\n`,
    );
  }
}

function writeLegacyCacheSessionState(
  stateDir: string,
  options: { empty?: boolean; includePrompt?: boolean; replaceNodes?: boolean } = {},
) {
  const dbPath = join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    if (options.replaceNodes) {
      db.exec("DROP TABLE session_nodes;");
    }
    db.exec(`
      CREATE TABLE cache_entries (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL
      );
    `);
    if (options.empty) {
      return;
    }
    const insert = db.prepare(
      "INSERT INTO cache_entries (scope, key, value_json) VALUES (?, ?, ?)",
    );
    for (const [key, entry] of Object.entries(createMigratedSessionFileStore(options))) {
      insert.run("session_entries", key, JSON.stringify(entry));
    }
  } finally {
    db.close();
  }
}

function writeLegacySessionEntriesState(stateDir: string): void {
  const dbPath = join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      DROP TABLE session_nodes;
      CREATE TABLE session_entries (
        session_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const insert = db.prepare(`
      INSERT INTO session_entries (session_key, session_id, entry_json, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const [key, entry] of Object.entries(createMigratedSessionFileStore())) {
      const sessionId = entry.sessionId;
      if (typeof sessionId !== "string") {
        throw new TypeError(`missing fixture session id for ${key}`);
      }
      insert.run(key, sessionId, JSON.stringify(entry), 1710000000000);
    }
  } finally {
    db.close();
  }
}

function runSessionStateAssertion(
  setup: (stateDir: string) => void | NodeJS.ProcessEnv,
  options: { scenario?: string; commands?: string[] } = {},
): void {
  const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-session-state-"));
  try {
    const stateDir = join(root, "state");
    const workspace = join(root, "workspace");
    mkdirSync(join(stateDir, "agents", "main", "sessions"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "IDENTITY.md"), "# survivor\n");
    writeJson(join(stateDir, "agents", "main", "sessions", "legacy-session.json"), {
      id: "legacy-session",
    });
    const fixtureEnv = setup(stateDir);
    for (const command of options.commands ?? ["assert-state"]) {
      execFileSync(process.execPath, [ASSERTIONS_PATH, command], {
        env: {
          ...process.env,
          ...(fixtureEnv ?? {}),
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_WORKSPACE_DIR: workspace,
          OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: options.scenario ?? "base",
        },
        stdio: "pipe",
      });
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function assertConfiguredPluginState(params: { installPath?: string } = {}): void {
  const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-"));
  try {
    const stateDir = join(root, "state");
    const workspace = join(root, "workspace");
    const matrixInstallDir = params.installPath ?? join(stateDir, "extensions", "matrix");
    mkdirSync(join(stateDir, "agents", "main", "sessions"), { recursive: true });
    mkdirSync(join(stateDir, "plugins"), { recursive: true });
    mkdirSync(matrixInstallDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "IDENTITY.md"), "# survivor\n");
    writeJson(join(stateDir, "agents", "main", "sessions", "legacy-session.json"), {
      id: "legacy-session",
    });
    writeMigratedSessionState(stateDir);
    writeJson(join(matrixInstallDir, "package.json"), {
      name: "@openclaw/matrix",
    });
    writeJson(join(stateDir, "plugins", "installs.json"), {
      installRecords: {
        matrix: {
          source: "clawhub",
          spec: "clawhub:@openclaw/matrix",
          installPath: matrixInstallDir,
          clawhubPackage: "@openclaw/matrix",
          clawhubChannel: "official",
          artifactKind: "npm-pack",
        },
      },
      plugins: [{ pluginId: "matrix", enabled: true }],
    });
    const coveragePath = join(root, "coverage.json");
    writeJson(coveragePath, {
      acceptedIntents: ["configured-plugin-installs"],
      skippedIntents: [],
    });

    execFileSync(process.execPath, [ASSERTIONS_PATH, "assert-state"], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TEST_WORKSPACE_DIR: workspace,
        OPENCLAW_UPGRADE_SURVIVOR_CONFIG_COVERAGE_JSON: coveragePath,
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "configured-plugin-installs",
      },
      stdio: "pipe",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function assertConfig(params: {
  acceptedIntents: string[];
  config: unknown;
  scenario: string;
  stage?: "baseline" | "survival";
  updateChannel?: string;
}): void {
  const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-config-"));
  try {
    const configPath = join(root, "openclaw.json");
    const coveragePath = join(root, "coverage.json");
    writeJson(configPath, params.config);
    writeJson(coveragePath, {
      acceptedIntents: params.acceptedIntents,
      skippedIntents: [],
    });

    execFileSync(process.execPath, [ASSERTIONS_PATH, "assert-config"], {
      env: {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_UPGRADE_SURVIVOR_CONFIG_COVERAGE_JSON: coveragePath,
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: params.scenario,
        OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE: params.stage ?? "survival",
        OPENCLAW_UPGRADE_SURVIVOR_UPDATE_CHANNEL: params.updateChannel ?? "",
      },
      stdio: "pipe",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

const ACCEPTED_SURFACE = {
  channels: [],
  providers: [],
  tools: [],
  contracts: [],
  hooks: [],
  mcpServers: [],
  cliCommands: [],
  cliBackends: [],
  skills: [],
  dangerousConfigFlags: [],
};

function acceptedSurfaceHash(): string {
  return createHash("sha256").update(JSON.stringify(ACCEPTED_SURFACE)).digest("hex");
}

function assertCompanionPluginRecords(
  mutate?: (
    records: Record<string, Record<string, unknown>>,
    installPaths: Record<"codex" | "discord" | "whatsapp", string>,
  ) => void,
  capabilityConsentSupported = true,
  recoveryPluginIds?: string[],
): void {
  const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-companions-"));
  try {
    const stateDir = join(root, "state");
    const version = "2026.8.1";
    const discordInstallPath = join(
      stateDir,
      "npm",
      "projects",
      "discord",
      "node_modules",
      "@openclaw",
      "discord",
    );
    const codexInstallPath = join(
      stateDir,
      "npm",
      "projects",
      "codex",
      "node_modules",
      "@openclaw",
      "codex",
    );
    const whatsappInstallPath = join(stateDir, "extensions", "whatsapp");
    for (const [installPath, packageName] of [
      [discordInstallPath, "@openclaw/discord"],
      [whatsappInstallPath, "@openclaw/whatsapp"],
      [codexInstallPath, "@openclaw/codex"],
    ] as const) {
      mkdirSync(installPath, { recursive: true });
      writeJson(join(installPath, "package.json"), { name: packageName, version });
    }
    const npmIntegrity = "sha512-upgrade-survivor";
    const clawpackSha256 = "a".repeat(64);
    const consent = (integrity: string) => ({
      acceptedSurface: ACCEPTED_SURFACE,
      acceptedSurfaceHash: acceptedSurfaceHash(),
      acceptedSurfaceAt: "2026-08-27T00:00:00.000Z",
      acceptedSurfaceIntegrity: integrity,
    });
    const records: Record<string, Record<string, unknown>> = {
      discord: {
        source: "npm",
        spec: `@openclaw/discord@${version}`,
        resolvedName: "@openclaw/discord",
        resolvedVersion: version,
        integrity: npmIntegrity,
        installPath: discordInstallPath,
        ...(capabilityConsentSupported ? consent(npmIntegrity) : {}),
      },
      whatsapp: {
        source: "clawhub",
        spec: `clawhub:@openclaw/whatsapp@${version}`,
        version,
        clawhubPackage: "@openclaw/whatsapp",
        clawhubChannel: "official",
        artifactKind: "npm-pack",
        clawpackSha256,
        installPath: whatsappInstallPath,
        ...(capabilityConsentSupported ? consent(clawpackSha256) : {}),
      },
      codex: {
        source: "npm",
        spec: `@openclaw/codex@${version}`,
        resolvedName: "@openclaw/codex",
        resolvedVersion: version,
        integrity: npmIntegrity,
        installPath: codexInstallPath,
        ...(capabilityConsentSupported ? consent(npmIntegrity) : {}),
      },
    };
    mutate?.(records, {
      codex: codexInstallPath,
      discord: discordInstallPath,
      whatsapp: whatsappInstallPath,
    });
    mkdirSync(join(stateDir, "plugins"), { recursive: true });
    writeJson(join(stateDir, "plugins", "installs.json"), { installRecords: records });
    const updateFile = join(root, "update.json");
    if (recoveryPluginIds) {
      writeJson(updateFile, {
        ...RECOVERABLE_UPDATE,
        postUpdate: {
          plugins: {
            ...RECOVERABLE_UPDATE.postUpdate.plugins,
            warnings: recoveryPluginIds.map((pluginId) => ({
              reason: `Plugin "${pluginId}" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.`,
              message: `Plugin "${pluginId}" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.`,
            })),
          },
        },
      });
    }
    execFileSync(
      process.execPath,
      [
        ASSERTIONS_PATH,
        ...(recoveryPluginIds
          ? ["assert-recovered-plugin-installs", updateFile, version, "", "2026.7.1-2"]
          : ["assert-companion-installs", version, capabilityConsentSupported ? "1" : "0"]),
      ],
      {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
        },
        stdio: "pipe",
      },
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function createUpdateRunSelfUpgradeSummary() {
  const sourceVersion = "2026.4.26";
  const targetVersion = "2026.7.2";
  const note = "QA-UPDATE-RUN-PACKAGE-SELF-UPGRADE";
  return {
    status: "passed",
    source: { spec: `openclaw@${sourceVersion}`, version: sourceVersion },
    target: { tag: "latest", resolvedVersion: targetVersion },
    installedVersion: targetVersion,
    expectedRestartNote: note,
    updateRpcResult: {
      ok: true,
      result: {
        status: "ok",
        before: { version: sourceVersion },
        after: { version: targetVersion },
        steps: [{ name: "package manager install" }],
      },
      restart: { scheduled: true },
      sentinel: { payload: { message: note } },
    },
    restartSentinel: {
      kind: "update",
      status: "ok",
      message: note,
      stats: {
        before: { version: sourceVersion },
        after: { version: targetVersion },
      },
    },
    qaChannelInstallRecord: {
      source: "path",
      sourcePath: "/tmp/source/dist/extensions/qa-channel",
      installPath: "/tmp/source/dist/extensions/qa-channel",
      version: "2026.4.25",
    },
    sourcePluginInspect: {
      plugin: { id: "qa-channel", status: "loaded" },
    },
    targetPluginIndex: {
      installRecords: {
        "qa-channel": {
          source: "path",
          sourcePath: "/tmp/source/dist/extensions/qa-channel",
          installPath: "/tmp/source/dist/extensions/qa-channel",
          version: "2026.4.25",
        },
      },
    },
    supervisorHandoff: {
      servicePid: 4242,
      systemctlInvocations: ["--user start openclaw-gateway.service"],
      monitorEvents: [
        "source Gateway exited through supervised update handoff",
        "starting installed service without provider suppression",
        "service Gateway started pid=4242",
      ],
    },
    gateway: {
      healthz: { body: { ok: true, status: "live" } },
      readyz: { body: { ready: true } },
      status: {
        cli: { version: targetVersion },
        gateway: { version: targetVersion },
        rpc: { ok: true, version: targetVersion },
      },
    },
    qaChannel: {
      status: {
        channelAccounts: {
          "qa-channel": [{ accountId: "default", running: true, restartPending: false }],
        },
      },
      busPollsAfterRestart: 2,
    },
  };
}

function assertUpdateRunSelfUpgrade(summary: ReturnType<typeof createUpdateRunSelfUpgradeSummary>) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-update-run-self-upgrade-"));
  try {
    const summaryPath = join(root, "summary.json");
    writeJson(summaryPath, summary);
    execFileSync(
      process.execPath,
      [ASSERTIONS_PATH, "assert-update-run-self-upgrade", summaryPath],
      { stdio: "pipe" },
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("upgrade survivor assertions", () => {
  it.runIf(process.platform !== "win32")(
    "rechecks migrated meeting state before materializing transcript exports",
    () => {
      expect(() =>
        runSessionStateAssertion(
          (stateDir) => {
            writeMigratedSessionState(stateDir);
            const archive = join(
              stateDir,
              "transcripts.migrated-fixture",
              "2026-07-01",
              "design-review",
            );
            mkdirSync(archive, { recursive: true });
            writeFileSync(
              join(archive, "transcript.jsonl"),
              ["legacy-u-1", "legacy-u-2"].map((id) => JSON.stringify({ id })).join("\n") + "\n",
            );
            writeFileSync(join(archive, "summary.md"), "Shipped transcript summary\n");
            mkdirSync(join(stateDir, "state"), { recursive: true });
            const db = new DatabaseSync(join(stateDir, "state", "openclaw.sqlite"));
            try {
              db.exec(`
              CREATE TABLE meeting_transcript_sessions (session_id, started_at, next_utterance_seq);
              INSERT INTO meeting_transcript_sessions VALUES ('design-review', '2026-07-01T10:00:00.000Z', 2);
              CREATE TABLE meeting_transcript_utterances (session_id, sequence, utterance_id, text);
              INSERT INTO meeting_transcript_utterances VALUES ('design-review', 0, 'legacy-u-1', 'First shipped transcript line');
              INSERT INTO meeting_transcript_utterances VALUES ('design-review', 1, 'legacy-u-2', 'Second shipped transcript line');
              CREATE TABLE migration_sources (migration_kind, status, removed_source, source_record_count);
              INSERT INTO migration_sources VALUES ('meeting-transcripts-files-v1', 'archived', 1, 2);
            `);
            } finally {
              db.close();
            }
            const binDir = join(stateDir, "bin");
            mkdirSync(binDir);
            writeFileSync(
              join(binDir, "openclaw"),
              `#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
assert.deepEqual(process.argv.slice(2), ["transcripts", "path", "2026-07-01/design-review", "--dir"]);
const root = process.env.OPENCLAW_STATE_DIR;
const sessionDir = path.join(root, "transcripts", "2026-07-01", "design-review");
fs.cpSync(path.join(root, "transcripts.migrated-fixture", "2026-07-01", "design-review"), sessionDir, { recursive: true });
process.stdout.write(sessionDir + "\\n");
`,
              { mode: 0o755 },
            );
            return { PATH: `${binDir}${delimiter}${process.env.PATH}` };
          },
          {
            scenario: "meeting-transcripts-sqlite",
            commands: ["assert-state", "assert-state", "assert-meeting-transcript-export"],
          },
        ),
      ).not.toThrow();
    },
  );

  it("lists the dependency-free scenario contract", () => {
    const scenarios = JSON.parse(
      execFileSync(process.execPath, [ASSERTIONS_PATH, "list-scenarios"], {
        encoding: "utf8",
      }),
    ) as string[];

    expect(scenarios).toContain("base");
    expect(scenarios).toContain("acpx-openclaw-tools-bridge");
    expect(scenarios).toContain("prerelease-plugin-registry");
    expect(scenarios).toContain("sqlite-volume");
    expect(new Set(scenarios).size).toBe(scenarios.length);
  });

  it.each([
    ["base", undefined, "stable", "beta"],
    ["base", "beta", "beta", "stable"],
    ["prerelease-plugin-registry", undefined, "beta", "stable"],
  ])(
    "requires the %s scenario with override %s to preserve the %s update channel",
    (scenario, updateChannel, expectedChannel, wrongChannel) => {
      const run = (channel: string) =>
        assertConfig({
          acceptedIntents: ["update"],
          config: { update: { channel } },
          scenario,
          updateChannel,
        });
      expect(() => run(expectedChannel)).not.toThrow();
      expect(() => run(wrongChannel)).toThrow(/update.channel/);
    },
  );

  it("seeds recent ordered legacy session timestamps", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-seed-"));
    try {
      const stateDir = join(root, "state");
      const workspace = join(root, "workspace");
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(workspace, { recursive: true });

      const beforeSeed = Date.now();
      execFileSync(process.execPath, [ASSERTIONS_PATH, "seed"], {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_WORKSPACE_DIR: workspace,
          OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "base",
        },
        stdio: "pipe",
      });
      const afterSeed = Date.now();

      const sessions = JSON.parse(
        readFileSync(join(stateDir, "sessions", "sessions.json"), "utf8"),
      ) as Record<string, { sessionId?: unknown; updatedAt?: unknown }>;
      const seededRows = [
        sessions.main,
        sessions["+15551234567"],
        sessions["slack:channel:CUPGRADE"],
      ];
      expect(seededRows.map((row) => row?.sessionId)).toEqual([
        "upgrade-main-session",
        "upgrade-direct-session",
        "upgrade-group-session",
      ]);

      const timestamps = seededRows.map((row) => row?.updatedAt);
      for (const timestamp of timestamps) {
        expect(typeof timestamp).toBe("number");
      }
      const [mainUpdatedAt, directUpdatedAt, groupUpdatedAt] = timestamps as [
        number,
        number,
        number,
      ];
      expect(directUpdatedAt - mainUpdatedAt).toBe(100);
      expect(groupUpdatedAt - mainUpdatedAt).toBe(200);
      expect(mainUpdatedAt).toBeLessThan(directUpdatedAt);
      expect(directUpdatedAt).toBeLessThan(groupUpdatedAt);

      const dayMs = 24 * 60 * 60 * 1000;
      const thirtyDaysMs = 30 * dayMs;
      for (const [timestamp, offset] of [
        [mainUpdatedAt, 0],
        [directUpdatedAt, 100],
        [groupUpdatedAt, 200],
      ] as const) {
        expect(timestamp).toBeGreaterThanOrEqual(beforeSeed - dayMs + offset);
        expect(timestamp).toBeLessThanOrEqual(afterSeed - dayMs + offset);
        expect(timestamp).toBeGreaterThan(afterSeed - thirtyDaysMs);
        expect(timestamp).toBeLessThanOrEqual(afterSeed);
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("accepts the ACPX OpenClaw tools bridge scenario during seed", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-acpx-"));
    try {
      const stateDir = join(root, "state");
      const workspace = join(root, "workspace");
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(workspace, { recursive: true });

      execFileSync(process.execPath, [ASSERTIONS_PATH, "seed"], {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_WORKSPACE_DIR: workspace,
          OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "acpx-openclaw-tools-bridge",
        },
        stdio: "pipe",
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("asserts the ACPX OpenClaw tools bridge config survived", () => {
    expect(() =>
      assertConfig({
        acceptedIntents: ["acpx-openclaw-tools-bridge"],
        config: {
          plugins: {
            allow: ["acpx"],
            entries: {
              acpx: {
                enabled: true,
                config: {
                  openClawToolsMcpBridge: true,
                },
              },
            },
          },
        },
        scenario: "acpx-openclaw-tools-bridge",
      }),
    ).not.toThrow();
  });

  it("allows legacy Discord DM config only at the baseline stage", () => {
    const legacyConfig = {
      channels: {
        discord: {
          enabled: true,
          dm: { policy: "allowlist", allowFrom: ["111111111111111111"] },
          guilds: {
            "222222222222222222": {
              channels: { "333333333333333333": { requireMention: true } },
            },
          },
          threadBindings: { idleHours: 72 },
        },
      },
    };
    expect(() =>
      assertConfig({
        acceptedIntents: ["discord-channel"],
        config: legacyConfig,
        scenario: "base",
        stage: "baseline",
      }),
    ).not.toThrow();
    expect(() =>
      assertConfig({
        acceptedIntents: ["discord-channel"],
        config: legacyConfig,
        scenario: "base",
      }),
    ).toThrow(/legacy Discord DM config survived/);
  });

  it("requires canonical Discord DM config after update", () => {
    expect(() =>
      assertConfig({
        acceptedIntents: ["discord-channel"],
        config: {
          channels: {
            discord: {
              enabled: true,
              dmPolicy: "allowlist",
              allowFrom: ["111111111111111111"],
              guilds: {
                "222222222222222222": {
                  channels: { "333333333333333333": { requireMention: true } },
                },
              },
              threadBindings: { idleHours: 72 },
            },
          },
        },
        scenario: "base",
      }),
    ).not.toThrow();
  });

  it("requires exact artifact-bound consent for direct companion installs", () => {
    expect(() => assertCompanionPluginRecords()).not.toThrow();
    expect(() =>
      assertCompanionPluginRecords((records) => {
        const discord = records.discord;
        if (!discord) {
          throw new Error("discord fixture missing");
        }
        Reflect.deleteProperty(discord, "acceptedSurfaceIntegrity");
      }),
    ).toThrow(/discord plugin consent integrity/);
  });

  it("requires artifact-bound consent for every published recovery plugin", () => {
    const ids = ["codex", "discord", "whatsapp"];
    expect(() => assertCompanionPluginRecords(undefined, true, ids)).not.toThrow();
    for (const id of ids) {
      expect(() =>
        assertCompanionPluginRecords(
          (records) => {
            records[id]!.acceptedSurfaceHash = "incorrect";
          },
          true,
          ids,
        ),
      ).toThrow(/plugin consent hash changed/);
      expect(() =>
        assertCompanionPluginRecords(
          (records) => {
            records[id]!.acceptedSurfaceIntegrity = "different-artifact";
          },
          true,
          ids,
        ),
      ).toThrow(/plugin consent integrity changed/);
    }
  });

  it("checks configured plugin recovery without requiring an unconfigured companion", () => {
    expect(() =>
      assertCompanionPluginRecords(
        (records, paths) => {
          records.matrix = {
            ...records.whatsapp,
            clawhubPackage: "@openclaw/matrix",
            spec: "clawhub:@openclaw/matrix@2026.8.1",
          };
          writeJson(join(paths.whatsapp, "package.json"), {
            name: "@openclaw/matrix",
            version: "2026.8.1",
          });
          delete records.whatsapp;
          const bravePath = join(paths.codex, "..", "brave-plugin");
          mkdirSync(bravePath, { recursive: true });
          writeJson(join(bravePath, "package.json"), {
            name: "@openclaw/brave-plugin",
            version: "2026.8.1",
          });
          records.brave = {
            ...records.codex,
            installPath: bravePath,
            resolvedName: "@openclaw/brave-plugin",
            spec: "@openclaw/brave-plugin@2026.8.1",
          };
        },
        true,
        ["discord", "matrix", "brave"],
      ),
    ).not.toThrow();
  });

  it("accepts frozen companion installs when the candidate lacks capability consent", () => {
    expect(() => assertCompanionPluginRecords(undefined, false)).not.toThrow();
  });

  it("requires artifact integrity when the candidate lacks capability consent", () => {
    expect(() =>
      assertCompanionPluginRecords((records) => {
        const discord = records.discord;
        if (!discord) {
          throw new Error("discord fixture missing");
        }
        Reflect.deleteProperty(discord, "integrity");
      }, false),
    ).toThrow(/discord plugin integrity missing/);
  });

  it.each([
    ["npm", "discord", "resolvedVersion", "version"],
    ["ClawHub", "whatsapp", "version", "resolvedVersion"],
  ] as const)(
    "requires the source-native version field for %s companion installs",
    (_sourceLabel, pluginId, requiredField, alternateField) => {
      expect(() =>
        assertCompanionPluginRecords((records) => {
          const record = records[pluginId];
          if (!record) {
            throw new Error(`${pluginId} fixture missing`);
          }
          record[alternateField] = record[requiredField];
          Reflect.deleteProperty(record, requiredField);
        }),
      ).toThrow(new RegExp(`${pluginId} plugin version changed`));
    },
  );

  it.each([
    ["npm", "discord"],
    ["ClawHub", "whatsapp"],
  ] as const)(
    "requires the installed package version to match for %s companion installs",
    (_sourceLabel, pluginId) => {
      expect(() =>
        assertCompanionPluginRecords((_records, installPaths) => {
          const packageName = pluginId === "discord" ? "@openclaw/discord" : "@openclaw/whatsapp";
          writeJson(join(installPaths[pluginId], "package.json"), {
            name: packageName,
            version: "2026.8.0",
          });
        }),
      ).toThrow(new RegExp(`${pluginId} installed package version changed`));
    },
  );

  it("accepts official ClawHub npm-pack installs for configured external plugins", () => {
    expect(() => assertConfiguredPluginState()).not.toThrow();
  });

  it("prefers session_nodes over stale file and cache session stores", () => {
    expect(() =>
      runSessionStateAssertion((stateDir) => {
        writeMigratedSessionState(stateDir);
        writeMigratedSessionFiles(stateDir, { includePrompt: false });
        writeLegacyCacheSessionState(stateDir, { includePrompt: false });
      }),
    ).not.toThrow();
  });

  it("does not mask missing session_nodes rows with a valid file store", () => {
    expect(() =>
      runSessionStateAssertion((stateDir) => {
        writeMigratedSessionState(stateDir);
        const db = new DatabaseSync(
          join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
        );
        try {
          db.exec("DELETE FROM session_nodes;");
        } finally {
          db.close();
        }
        writeMigratedSessionFiles(stateDir);
      }),
    ).toThrow(/main legacy session row missing/);
  });

  it("does not mask empty legacy cache_entries with a valid file store", () => {
    expect(() =>
      runSessionStateAssertion((stateDir) => {
        writeMigratedSessionState(stateDir);
        writeLegacyCacheSessionState(stateDir, { empty: true, replaceNodes: true });
        writeMigratedSessionFiles(stateDir);
      }),
    ).toThrow(/main legacy session row missing/);
  });

  it("prefers legacy cache_entries over a stale file session store", () => {
    expect(() =>
      runSessionStateAssertion((stateDir) => {
        writeMigratedSessionState(stateDir);
        writeLegacyCacheSessionState(stateDir, { replaceNodes: true });
        writeMigratedSessionFiles(stateDir, { includePrompt: false });
      }),
    ).not.toThrow();
  });

  it("prefers legacy session_entries over stale file and cache session stores", () => {
    expect(() =>
      runSessionStateAssertion((stateDir) => {
        writeMigratedSessionState(stateDir);
        writeLegacySessionEntriesState(stateDir);
        writeLegacyCacheSessionState(stateDir, { includePrompt: false });
        writeMigratedSessionFiles(stateDir, { includePrompt: false });
      }),
    ).not.toThrow();
  });

  it("uses the file session store when SQLite has no supported session table", () => {
    expect(() =>
      runSessionStateAssertion((stateDir) => {
        const agentDbDir = join(stateDir, "agents", "main", "agent");
        mkdirSync(agentDbDir, { recursive: true });
        const db = new DatabaseSync(join(agentDbDir, "openclaw-agent.sqlite"));
        try {
          db.exec("CREATE TABLE unrelated_state (key TEXT PRIMARY KEY);");
        } finally {
          db.close();
        }
        writeMigratedSessionFiles(stateDir);
      }),
    ).not.toThrow();
  });

  it("accepts a SQLite-only migrated session store", () => {
    expect(() =>
      runSessionStateAssertion((stateDir) => {
        writeMigratedSessionState(stateDir);
      }),
    ).not.toThrow();
  });

  it("rejects retired sessionFile metadata in SQLite-backed session rows", () => {
    expect(() =>
      runSessionStateAssertion((stateDir) => {
        writeMigratedSessionState(stateDir);
        const db = new DatabaseSync(
          join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
        );
        try {
          db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
            JSON.stringify({
              sessionFile: join(stateDir, "sessions", "upgrade-main-session.jsonl"),
            }),
            "agent:main:main",
          );
        } finally {
          db.close();
        }
      }),
    ).toThrow(/retained retired sessionFile metadata/);
  });

  it("rejects ClawHub npm-pack installs outside the managed extensions root", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-outside-"));
    try {
      expect(() =>
        assertConfiguredPluginState({ installPath: join(root, "outside-matrix") }),
      ).toThrow(/managed extensions root/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("accepts executed update.run package transition and post-restart health evidence", () => {
    expect(() => assertUpdateRunSelfUpgrade(createUpdateRunSelfUpgradeSummary())).not.toThrow();
  });

  it("rejects no-op update.run package transitions", () => {
    const summary = createUpdateRunSelfUpgradeSummary();
    summary.target.resolvedVersion = summary.source.version;
    summary.installedVersion = summary.source.version;
    summary.updateRpcResult.result.after.version = summary.source.version;
    summary.restartSentinel.stats.after.version = summary.source.version;
    summary.gateway.status.gateway.version = summary.source.version;

    expect(() => assertUpdateRunSelfUpgrade(summary)).toThrow(/did not advance beyond source/);
  });

  it("rejects unsupported update.run paths that did not execute package steps", () => {
    const summary = createUpdateRunSelfUpgradeSummary();
    summary.updateRpcResult.ok = false;
    summary.updateRpcResult.result.status = "skipped";
    summary.updateRpcResult.result.steps = [];

    expect(() => assertUpdateRunSelfUpgrade(summary)).toThrow(/did not report ok/);
  });

  it("rejects QA channel payloads without a canonical path install record", () => {
    const summary = createUpdateRunSelfUpgradeSummary();
    summary.qaChannelInstallRecord.source = "npm";

    expect(() => assertUpdateRunSelfUpgrade(summary)).toThrow(/was not path-installed/);
  });

  it("rejects upgrades that lose the path install during SQLite migration", () => {
    const summary = createUpdateRunSelfUpgradeSummary();
    Reflect.deleteProperty(summary.targetPluginIndex.installRecords, "qa-channel");

    expect(() => assertUpdateRunSelfUpgrade(summary)).toThrow(
      /target SQLite index did not preserve/,
    );
  });

  it("rejects source fixtures that were never runtime-loaded", () => {
    const summary = createUpdateRunSelfUpgradeSummary();
    summary.sourcePluginInspect.plugin.status = "error";

    expect(() => assertUpdateRunSelfUpgrade(summary)).toThrow(/source package did not load/);
  });

  it("rejects duplicate target service starts during the supervised handoff", () => {
    const summary = createUpdateRunSelfUpgradeSummary();
    summary.supervisorHandoff.systemctlInvocations.push(
      "--user --quiet start openclaw-gateway.service",
    );

    expect(() => assertUpdateRunSelfUpgrade(summary)).toThrow(/target exactly once/);
  });
});
