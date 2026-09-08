import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const command = resolve("scripts/e2e/lib/upgrade-survivor/assertions.mjs");

describe("upgrade survivor updater restart ownership", () => {
  it.each(
    [
      { outcome: "success", future: false, repaired: false },
      { outcome: "recoverable", future: false, repaired: false },
      { outcome: "success", future: true, repaired: false },
      { outcome: "success", future: true, repaired: true },
    ].flatMap(({ outcome, future, repaired }) =>
      [true, false].map((replacement) => ({ outcome, future, repaired, replacement })),
    ),
  )(
    "$outcome future=$future repaired=$repaired replacement=$replacement",
    ({ outcome, future, repaired, replacement }) => {
      const root = tempDirs.make("survivor-restart-result-");
      const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
      const helper = source.slice(
        source.indexOf("update_candidate()"),
        source.indexOf("\nreplace_historical_mobile_pairing_candidate()"),
      );
      const expectedVersion = future ? "2100.1.0" : "2026.9.2";
      const expectedSpec = future ? "file:/fixture/future.tgz" : "file:/fixture/candidate.tgz";
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -eu
ARTIFACT_ROOT="$1"
EXPECTED_VERSION="$2"
OUTCOME="$3"
AFTER_REPAIR="$4"
REPLACEMENT="$5"
update_repair_required="$6"
SCENARIO="$7"
UPDATE_RESTART_MODE=auto-auth
COMMAND_TIMEOUT=1
ROOT_MANAGED_VPS=0
baseline_spec=2026.9.1
baseline_version=2026.9.1
candidate_version=2026.9.2
CANDIDATE_KIND=ref
UPDATE_JSON="$ARTIFACT_ROOT/update.json"
UPDATE_ERR="$ARTIFACT_ROOT/update.err"
POST_UPDATE_VALIDATE_JSON="$ARTIFACT_ROOT/validate.json"
POST_UPDATE_VALIDATE_ERR="$ARTIFACT_ROOT/validate.err"
SYSTEMCTL_SHIM_PID_FILE="$ARTIFACT_ROOT/service.pid"
SYSTEMCTL_SHIM_LOG="$ARTIFACT_ROOT/service.log"
printf '1234\n' >"$SYSTEMCTL_SHIM_PID_FILE"
printf 'start\nready\n' >"$SYSTEMCTL_SHIM_LOG"
: >"$ARTIFACT_ROOT/events"
candidate_update_spec() { printf 'file:/fixture/candidate.tgz'; }
read_installed_version() { printf '%s' "$EXPECTED_VERSION"; }
openclaw_e2e_print_log() { :; }
openclaw_e2e_maybe_timeout() {
  printf '%s\n' "$@" >"$ARTIFACT_ROOT/argv"
  printf 'update\n' >>"$ARTIFACT_ROOT/events"
  if [ "$REPLACEMENT" = 1 ]; then
    printf '5678\n' >"$SYSTEMCTL_SHIM_PID_FILE"
    printf 'restart\n' >>"$SYSTEMCTL_SHIM_LOG"
  fi
  [ "$OUTCOME" = success ]
}
node() {
  if [ "$1" = -e ]; then printf 1000; return; fi
  [ "$1" = scripts/e2e/lib/upgrade-survivor/assertions.mjs ] || return 90
  printf '%s|%s\n' "$2" "$4" >>"$ARTIFACT_ROOT/events"
  [ "$4" = "$EXPECTED_VERSION" ] || return 91
  [ "$5" = "$last_update_observation_root" ] && [ -d "$5" ] || return 92
  case "$2" in
    assert-recoverable-update-json) [ "$6" = "$baseline_version" ] && [ "$OUTCOME" = recoverable ] ;;
    assert-successful-update-json) [ "$OUTCOME" = success ] ;;
    *) return 93 ;;
  esac
}
assert_update_restart_service_replaced() {
  printf 'replacement|%s|%d\n' "$1" "$2" >>"$ARTIFACT_ROOT/events"
  [ "$1" = 1234 ] && [ "$2" -eq 2 ] && [ "$REPLACEMENT" = 1 ]
}
${helper}
result_status=0
update_candidate "$AFTER_REPAIR" "$8" "$EXPECTED_VERSION" || result_status=$?
printf '\nresult:%s:%s:%s\n' "\${update_outcome:-unset}" "\${update_restart_source:-unset}" "\${update_exit_code:-unset}"
exit "$result_status"
`,
          "restart-result",
          root,
          expectedVersion,
          outcome,
          future ? "1" : "0",
          replacement ? "1" : "0",
          repaired ? "1" : "0",
          future ? "mobile-pairing-reconnect" : "legacy-operator-state",
          expectedSpec,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status, result.stderr).toBe(replacement ? 0 : 1);
      const args = readFileSync(join(root, "argv"), "utf8").trim().split("\n");
      expect(args.slice(args.indexOf("openclaw") + 1)).toEqual([
        "update",
        "--tag",
        expectedSpec,
        "--yes",
        "--json",
      ]);
      const events = readFileSync(join(root, "events"), "utf8").trim().split("\n");
      expect(events).toEqual([
        "update",
        ...(!future ? [`assert-recoverable-update-json|${expectedVersion}`] : []),
        ...(outcome === "success" ? [`assert-successful-update-json|${expectedVersion}`] : []),
        "replacement|1234|2",
      ]);
      const attribution = !replacement
        ? "unset"
        : !future
          ? "baseline-update"
          : repaired
            ? "candidate-after-repair"
            : "candidate-to-future";
      expect(result.stdout).toContain(
        `result:${outcome}:${attribution}:${outcome === "recoverable" ? 1 : 0}`,
      );
    },
  );
});

function deniedUpdate() {
  return {
    status: "error",
    mode: "npm",
    reason: "post-update-plugins",
    before: { version: "2026.7.1-2" },
    after: { version: "2026.8.1" },
    steps: [
      { name: "global update", exitCode: 0 },
      { name: "global install swap", exitCode: 0 },
    ],
    postUpdate: {
      plugins: {
        status: "error",
        reason: "post-plugin-doctor-invalid-config",
        sync: { errors: [] as string[] },
        npm: { outcomes: [] as { status: string }[] },
        integrityDrifts: [] as string[],
        warnings: ["codex", "discord", "whatsapp"].map((id) => {
          const message = `Plugin "${id}" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.`;
          return { reason: message, message };
        }),
      },
    },
  };
}

function deferredUpdate() {
  const update = deniedUpdate();
  const codexWarning = expectDefined(
    update.postUpdate.plugins.warnings[0],
    "Codex consent warning",
  );
  const reason = 'Plugin "codex" requires capability consent; rerun with --accept-capabilities.';
  const message = `Plugin "codex" could not be processed after the core update: ${reason} Run openclaw update repair to retry post-update plugin repair. Run openclaw plugins inspect codex --runtime --json for details.`;
  const retained = `Kept installed plugin "codex"; replacement deferred. ${codexWarning.reason}`;
  return {
    ...update,
    status: "ok",
    reason: undefined,
    postUpdate: {
      plugins: {
        ...update.postUpdate.plugins,
        status: "warning",
        reason: undefined,
        npm: {
          outcomes: [
            {
              pluginId: "codex",
              status: "error",
              code: "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
              message,
            },
            { pluginId: "discord", status: "updated", nextVersion: "2026.8.1" },
          ],
        },
        warnings: [
          { reason, message },
          expectDefined(update.postUpdate.plugins.warnings[2], "WhatsApp consent warning"),
          { reason: retained, message: retained },
        ],
      },
    },
  };
}

function check(result: unknown, prefix = "") {
  const filename = join(tempDirs.make("survivor-update-result-"), "update.json");
  writeFileSync(filename, prefix + JSON.stringify(result));
  return spawnSync(
    process.execPath,
    [command, "assert-recoverable-update-json", filename, "2026.8.1", "", "2026.7.1-2"],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

describe("published upgrade survivor consent recovery", () => {
  it.each(
    ["acpx", "feishu"].flatMap((pluginId) =>
      ["error", "ok"].map((status) => ({ pluginId, status })),
    ),
  )("admits $pluginId fixture consent after a $status update", ({ pluginId, status }) => {
    const update = deniedUpdate();
    const reason = `Plugin "${pluginId}" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.`;
    update.postUpdate.plugins.warnings.push({ reason, message: reason });
    const result = check({
      ...update,
      status,
      reason: status === "error" ? update.reason : undefined,
      postUpdate: {
        plugins: {
          ...update.postUpdate.plugins,
          status: status === "error" ? "error" : "warning",
          reason: status === "error" ? update.postUpdate.plugins.reason : undefined,
        },
      },
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["acpx", "feishu"])("rejects non-consent failures from reviewed %s", (pluginId) => {
    const update = deferredUpdate();
    const outcome = expectDefined(update.postUpdate.plugins.npm.outcomes[0], "plugin outcome");
    outcome.pluginId = pluginId;
    outcome.code = "INSTALL_FAILED";
    expect(check(update).status).not.toBe(0);
  });

  it("repairs capability deferrals even when retaining the old plugin makes core update successful", () => {
    const result = check(deferredUpdate());
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["INSTALL_FAILED", undefined])("rejects unrelated plugin outcome %s", (code) => {
    const update = deferredUpdate();
    expectDefined(update.postUpdate.plugins.npm.outcomes[0], "Codex update outcome").code = code;
    expect(check(update).status).not.toBe(0);
  });

  it("accepts only the reviewed externalized fixture packages after successful core replacement", () => {
    const update = deniedUpdate();
    update.postUpdate.plugins.warnings.push({
      reason: "Config remained invalid after updated plugin migrations.",
      message: "Post-update plugin migration did not produce a valid config; refusing to restart.",
    });
    const result = check(update);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    [
      "core update failure",
      (result: ReturnType<typeof deniedUpdate>) =>
        (expectDefined(result.steps[0], "global update step").exitCode = 1),
    ],
    [
      "wrong installed version",
      (result: ReturnType<typeof deniedUpdate>) => (result.after.version = "2026.7.1-2"),
    ],
    [
      "wrong baseline version",
      (result: ReturnType<typeof deniedUpdate>) => (result.before.version = "2026.8.1"),
    ],
    ["missing core swap", (result: ReturnType<typeof deniedUpdate>) => result.steps.pop()],
    [
      "other update failure",
      (result: ReturnType<typeof deniedUpdate>) => (result.reason = "doctor"),
    ],
    [
      "plugin sync failure",
      (result: ReturnType<typeof deniedUpdate>) =>
        result.postUpdate.plugins.sync.errors.push("network failed"),
    ],
    [
      "plugin update failure",
      (result: ReturnType<typeof deniedUpdate>) =>
        result.postUpdate.plugins.npm.outcomes.push({ status: "error" }),
    ],
    [
      "integrity drift",
      (result: ReturnType<typeof deniedUpdate>) =>
        result.postUpdate.plugins.integrityDrifts.push("changed"),
    ],
    [
      "unreviewed plugin",
      (result: ReturnType<typeof deniedUpdate>) => {
        const warning = expectDefined(
          result.postUpdate.plugins.warnings[0],
          "Codex consent warning",
        );
        warning.reason = warning.reason.replace("codex", "unreviewed");
        warning.message = warning.reason;
      },
    ],
    [
      "unrelated warning",
      (result: ReturnType<typeof deniedUpdate>) =>
        result.postUpdate.plugins.warnings.push({
          reason: "broken config",
          message: "broken config",
        }),
    ],
    [
      "no consent denial",
      (result: ReturnType<typeof deniedUpdate>) => (result.postUpdate.plugins.warnings = []),
    ],
  ])("refuses repair after %s", (_name, mutate) => {
    const result = deniedUpdate();
    mutate(result);
    expect(check(result).status).not.toBe(0);
  });
});

const schemaCommand = resolve("scripts/e2e/lib/upgrade-survivor/schema-expectation.mjs");

function writeSchema(file: string, version: number) {
  mkdirSync(dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  try {
    database.exec(`PRAGMA user_version = ${version}`);
  } finally {
    database.close();
  }
}

function schemaFixture(
  baselineVersion = "2026.9.2",
  stateVersion: number | null = 15,
  agentVersion: number | null = 19,
  seedState?: (stateDir: string) => void,
) {
  const root = tempDirs.make("survivor-schema-expectation-");
  const stateDir = join(root, "state");
  const stateDatabase = join(stateDir, "state", "openclaw.sqlite");
  const agentDatabase = join(stateDir, "agents", "ops", "agent", "openclaw-agent.sqlite");
  if (stateVersion !== null) {
    writeSchema(stateDatabase, stateVersion);
  }
  if (agentVersion !== null) {
    writeSchema(agentDatabase, agentVersion);
  }
  seedState?.(stateDir);
  const configFile = join(root, "openclaw.json");
  writeFileSync(configFile, JSON.stringify({ agents: { entries: { main: {}, ops: {} } } }));
  const candidateDir = join(root, "package");
  mkdirSync(candidateDir);
  // Main can retain the released version while its schema contract advances.
  const candidateVersion = "2026.9.2";
  writeFileSync(
    join(candidateDir, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: candidateVersion,
      openclaw: { schemaVersions: { state: 16, agent: 19 } },
    }),
  );
  const tarball = join(root, "candidate.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", root, "package"]);
  const snapshotFile = join(root, "snapshot.json");
  const afterFile = join(root, "schema-after.json");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [schemaCommand, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    });
  const prepare = () =>
    run("prepare", baselineVersion, tarball, stateDir, snapshotFile, configFile);
  const prepared = prepare();
  expect(prepared.status, prepared.stderr).toBe(0);
  function checkSchemaOutcome(
    exitCode = 0,
    installedVersion = candidateVersion,
    acceptedOutcome = "success",
  ) {
    return run(
      "assert",
      snapshotFile,
      String(exitCode),
      installedVersion,
      acceptedOutcome,
      afterFile,
    );
  }
  return {
    prepared,
    prepare,
    stateDir,
    check: checkSchemaOutcome,
    stateDatabase,
    agentDatabase,
    snapshotFile,
    afterFile,
    candidateVersion,
  };
}

function legacyAgentFixture(agentId = "main") {
  const sessionKey = `agent:${agentId}:explicit:seeded-turn`;
  const events = [
    { type: "session", id: "seeded-turn", version: 3 },
    {
      type: "message",
      id: "user-message",
      message: { role: "user", content: "Keep this history" },
    },
    {
      type: "message",
      id: "reply",
      message: { role: "assistant", content: [{ type: "text", text: "Saved reply" }] },
    },
  ];
  const index = { [sessionKey]: { sessionId: "seeded-turn" } };
  const sourceNames = [
    "sessions.json",
    "seeded-turn.jsonl",
    "seeded-turn.trajectory.jsonl",
    "seeded-turn.trajectory-path.json",
  ];
  const lane = schemaFixture("2026.6.34", 1, null, (stateDir) => {
    const sessions = join(stateDir, "agents", agentId, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "sessions.json"), JSON.stringify(index));
    writeFileSync(
      join(sessions, "seeded-turn.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    writeFileSync(join(sessions, "seeded-turn.trajectory.jsonl"), '{"type":"session.started"}\n');
    writeFileSync(join(sessions, "seeded-turn.trajectory-path.json"), '{"version":1}');
    const prompt = join(sessions, "skills-prompts", "sha256", "aa", `${"a".repeat(64)}.txt`);
    mkdirSync(dirname(prompt), { recursive: true });
    writeFileSync(prompt, "Retained prompt");
  });
  const sessions = join(lane.stateDir, "agents", agentId, "sessions");
  const databasePath = join(lane.stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  const archiveDir = join(lane.stateDir, "agents", agentId, "session-sqlite-import-archive");
  const promptPath = join(sessions, "skills-prompts", "sha256", "aa", `${"a".repeat(64)}.txt`);
  const manifestPath = join(lane.stateDir, "session-sqlite-migration-runs", "import.json");
  function migrate() {
    writeSchema(lane.stateDatabase, 16);
    writeSchema(databasePath, 19);
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(
        "CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT); CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT)",
      );
      db.prepare("INSERT INTO session_nodes VALUES (?, ?)").run(sessionKey, "seeded-turn");
      for (const [seq, event] of events.entries()) {
        db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?)").run(
          "seeded-turn",
          seq,
          JSON.stringify(event),
        );
      }
    } finally {
      db.close();
    }
    mkdirSync(archiveDir, { recursive: true });
    const completedMoves = sourceNames.map((name) => {
      const sourcePath = join(sessions, name);
      const archivePath = join(archiveDir, `${name}.imported-1`);
      renameSync(sourcePath, archivePath);
      return {
        sourcePath,
        archivePath,
        kind:
          name === "sessions.json"
            ? "legacy-store"
            : name.includes("trajectory")
              ? "trajectory"
              : "transcript",
      };
    });
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        completedAt: "2026-09-07",
        targets: [
          { agentId, sqlitePath: databasePath, validationBeforeArchive: "passed", completedMoves },
        ],
      }),
    );
  }
  return { ...lane, migrate, databasePath, archiveDir, sessions, promptPath, manifestPath };
}

describe("published survivor schema outcome", () => {
  it.each([
    [0, "success", true],
    [1, "success", false],
    [0, "recoverable", true],
    [1, "recoverable", true],
    [2, "recoverable", false],
    [0, "schema-refusal", false],
    [1, "schema-refusal", false],
  ] as const)(
    "checks migrated schemas after exit %i classified as %s",
    (code, outcome, accepted) => {
      const lane = schemaFixture();
      writeSchema(lane.stateDatabase, 16);
      const result = lane.check(code, lane.candidateVersion, outcome);
      expect(result.status, result.stderr).toBe(accepted ? 0 : 1);
    },
  );

  it.each([
    ["2026.9.2", 15, 19],
    ["2026.9.2-rebuild.1", 15, 19],
    ["2026.9.2", 16, 18],
    ["2026.9.2", 16, 19],
    ["2026.9.1", 15, 18],
    ["2026.6.34", 0, 0],
    ["2026.9.3-beta.1", 15, 18],
    ["2026.9.3", 15, 18],
  ] as const)(
    "requires %s to upgrade successfully from schemas %i/%i",
    (baseline, state, agent) => {
      const lane = schemaFixture(baseline, state, agent);
      expect(lane.prepared.stdout.trim()).toBe("success");
      expect(lane.check(1).status).toBe(1);
      writeSchema(lane.stateDatabase, 16);
      writeSchema(lane.agentDatabase, 19);
      const result = lane.check();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("success");
    },
  );

  it("ignores model catalogs and unrelated agent files while retaining strict session classification", () => {
    const lane = schemaFixture("2026.7.1-2", 1, null, (stateDir) => {
      const agentDir = join(stateDir, "agents", "main", "agent");
      mkdirSync(join(agentDir, "provider-cache"), { recursive: true });
      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify({ providers: { survivor: { models: [] } } }),
      );
      writeFileSync(join(agentDir, "provider-cache", "unrelated.txt"), "Not a migration specimen");
    });
    const snapshot = JSON.parse(readFileSync(lane.snapshotFile, "utf8"));
    expect(snapshot.agents).toEqual([
      {
        agentId: "main",
        databaseRelative: "agents/main/agent/openclaw-agent.sqlite",
        requiresDatabase: false,
        files: [],
      },
      {
        agentId: "ops",
        databaseRelative: "agents/ops/agent/openclaw-agent.sqlite",
        requiresDatabase: false,
        files: [],
      },
    ]);
    const sessions = join(lane.stateDir, "agents", "main", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "unknown.json"), "{}");
    const result = lane.prepare();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "unclassified baseline agent specimen: agents/main/sessions/unknown.json",
    );
  });

  it.each(["main", "ops"])("requires the legacy %s store before candidate probes", (agentId) => {
    const lane = legacyAgentFixture(agentId);
    writeSchema(lane.stateDatabase, 16);
    const result = lane.check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `required agent database missing before candidate probes: ${agentId}`,
    );
  });

  it("records the seeded roster and every legacy specimen, allowing the unused agent to stay lazy", () => {
    const lane = legacyAgentFixture();
    const snapshot = JSON.parse(readFileSync(lane.snapshotFile, "utf8"));
    expect(
      snapshot.agents.map((agent: { agentId: string; requiresDatabase: boolean }) => [
        agent.agentId,
        agent.requiresDatabase,
      ]),
    ).toEqual([
      ["main", true],
      ["ops", false],
    ]);
    expect(snapshot.agents[0].files.map((file: { kind: string }) => file.kind).toSorted()).toEqual([
      "legacy-store",
      "skill-prompt",
      "trajectory",
      "trajectory",
      "transcript",
    ]);
    lane.migrate();
    const preserved = [
      lane.databasePath,
      lane.promptPath,
      lane.manifestPath,
      join(lane.archiveDir, "seeded-turn.jsonl.imported-1"),
    ];
    const before = preserved.map((file) => readFileSync(file));
    const result = lane.check();
    expect(result.status, result.stderr).toBe(0);
    expect(preserved.map((file) => readFileSync(file))).toEqual(before);
    expect(existsSync(join(lane.stateDir, "agents", "ops", "agent", "openclaw-agent.sqlite"))).toBe(
      false,
    );
  });

  it.each([
    [
      "required store removed",
      (lane: ReturnType<typeof legacyAgentFixture>) => rmSync(lane.databasePath),
      "required agent database missing",
    ],
    [
      "old agent schema",
      (lane: ReturnType<typeof legacyAgentFixture>) => writeSchema(lane.databasePath, 18),
      "required agent database lacks candidate schema",
    ],
    [
      "active legacy source",
      (lane: ReturnType<typeof legacyAgentFixture>) =>
        writeFileSync(join(lane.sessions, "sessions.json"), "{}"),
      "specimen was not retired",
    ],
    [
      "missing archive receipt",
      (lane: ReturnType<typeof legacyAgentFixture>) => rmSync(lane.manifestPath),
      "lacks completed archive receipt",
    ],
    [
      "lost transcript archive",
      (lane: ReturnType<typeof legacyAgentFixture>) =>
        rmSync(join(lane.archiveDir, "seeded-turn.jsonl.imported-1")),
      "archive missing",
    ],
    [
      "changed trajectory",
      (lane: ReturnType<typeof legacyAgentFixture>) =>
        writeFileSync(join(lane.archiveDir, "seeded-turn.trajectory.jsonl.imported-1"), "changed"),
      "archive changed",
    ],
    [
      "lost prompt blob",
      (lane: ReturnType<typeof legacyAgentFixture>) => rmSync(lane.promptPath),
      "skill prompt missing",
    ],
    [
      "changed prompt blob",
      (lane: ReturnType<typeof legacyAgentFixture>) => writeFileSync(lane.promptPath, "changed"),
      "skill prompt changed",
    ],
  ] as const)("rejects %s before candidate probes", (_label, corrupt, diagnostic) => {
    const lane = legacyAgentFixture();
    lane.migrate();
    corrupt(lane);
    const result = lane.check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
  });

  it.each([
    ["session row", "DELETE FROM session_nodes", "legacy session was not imported"],
    [
      "transcript event",
      "DELETE FROM transcript_events WHERE seq = 2",
      "legacy transcript event was not imported",
    ],
    [
      "message content",
      `UPDATE transcript_events SET event_json = '{"type":"message","id":"reply","message":{"role":"assistant","content":"lost reply"}}' WHERE seq = 2`,
      "legacy transcript event was not imported",
    ],
  ])(
    "rejects missing or changed %s despite a current schema and archived sources",
    (_label, sql, diagnostic) => {
      const lane = legacyAgentFixture();
      lane.migrate();
      const db = new DatabaseSync(lane.databasePath);
      try {
        db.exec(sql);
      } finally {
        db.close();
      }
      const result = lane.check();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(diagnostic);
    },
  );

  it("observes migrated schemas without changing database bytes", () => {
    const lane = schemaFixture();
    writeSchema(lane.stateDatabase, 16);
    const files = [lane.stateDatabase, lane.agentDatabase];
    const before = files.map((file) => readFileSync(file));
    const result = lane.check();
    expect(result.status, result.stderr).toBe(0);
    expect(files.map((file) => readFileSync(file))).toEqual(before);
  });

  it.each([
    [15, "16", true],
    [16, "15", true],
    [15, "15", false],
    [16, "17", false],
    [15, '"16"', false],
    [15, "-1", false],
    [15, "broken", false],
  ] as const)(
    "observes published schema %i with content marker %s without changing it",
    (published, marker, accepted) => {
      const lane = schemaFixture();
      writeSchema(lane.stateDatabase, published);
      const database = new DatabaseSync(lane.stateDatabase);
      try {
        database.exec(
          "CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL)",
        );
        database
          .prepare("INSERT INTO config_machine_state VALUES (?, ?)")
          .run("state.schema.contentVersion", marker);
      } finally {
        database.close();
      }
      const before = readFileSync(lane.stateDatabase);
      const result = lane.check();
      expect(result.status, result.stderr).toBe(accepted ? 0 : 1);
      expect(readFileSync(lane.stateDatabase)).toEqual(before);
      if (accepted) {
        expect(JSON.parse(readFileSync(lane.afterFile, "utf8")).databases).toContainEqual({
          kind: "state",
          relative: "state/openclaw.sqlite",
          userVersion: published,
          contentVersion: 16,
        });
      }
    },
  );

  it("expects success for a JSON-era baseline without creating SQLite state while observing it", () => {
    const lane = schemaFixture("2026.6.34", null, null);
    expect(lane.prepared.stdout.trim()).toBe("success");
    expect(JSON.parse(readFileSync(lane.snapshotFile, "utf8")).databases).toEqual([
      { kind: "state", relative: "state/openclaw.sqlite", userVersion: null, contentVersion: null },
    ]);
    expect(existsSync(lane.stateDatabase)).toBe(false);
    expect(existsSync(lane.agentDatabase)).toBe(false);
    writeSchema(lane.stateDatabase, 16);
    writeSchema(lane.agentDatabase, 19);
    const result = lane.check();
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    [
      "state migration missing",
      (lane: ReturnType<typeof schemaFixture>) => writeSchema(lane.stateDatabase, 15),
      "candidate schema",
    ],
    [
      "agent migration missing",
      (lane: ReturnType<typeof schemaFixture>) => writeSchema(lane.agentDatabase, 18),
      "candidate schema",
    ],
    [
      "state schema too new",
      (lane: ReturnType<typeof schemaFixture>) => writeSchema(lane.stateDatabase, 17),
      "candidate schema",
    ],
    [
      "agent schema too new",
      (lane: ReturnType<typeof schemaFixture>) => writeSchema(lane.agentDatabase, 20),
      "candidate schema",
    ],
    [
      "state database lost",
      (lane: ReturnType<typeof schemaFixture>) => rmSync(lane.stateDatabase),
      "candidate schema",
    ],
    [
      "agent database lost",
      (lane: ReturnType<typeof schemaFixture>) => rmSync(lane.agentDatabase),
      "required agent database missing before candidate probes: ops",
    ],
  ] as const)("rejects %s after a reported successful update", (_name, change, diagnostic) => {
    const lane = schemaFixture("2026.9.2", 15, 18);
    writeSchema(lane.stateDatabase, 16);
    writeSchema(lane.agentDatabase, 19);
    change(lane);
    const result = lane.check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
  });

  it("rejects a rollback that leaves the baseline package version installed", () => {
    const lane = schemaFixture("2026.9.1");
    writeSchema(lane.stateDatabase, 16);
    const result = lane.check(0, "2026.9.1");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("candidate package is not installed");
  });

  it.each([
    ["assert-successful-update-json", "update did not report ok"],
    ["assert-recoverable-update-json", "doctor-failed"],
  ])("rejects typed schema refusal through %s", (assertion, diagnostic) => {
    const file = join(tempDirs.make("survivor-refused-update-"), "update.json");
    writeFileSync(
      file,
      JSON.stringify({
        status: "error",
        mode: "npm",
        reason: "doctor-failed",
        before: { version: "2026.9.2" },
        after: { version: "2026.9.2" },
        steps: [
          { name: "global update", exitCode: 0 },
          { name: "global install swap", exitCode: 0 },
          {
            name: "openclaw doctor",
            exitCode: 1,
            stdoutTail: JSON.stringify({
              ok: false,
              error: { code: "update-schema-bump-unfenced" },
            }),
          },
        ],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [command, assertion, file, "2026.9.2", "", "2026.9.2"],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
  });
});
