import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const command = resolve("scripts/e2e/lib/upgrade-survivor/assertions.mjs");

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
  const packageRoot = join(root, "baseline");
  mkdirSync(packageRoot);
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version: baselineVersion }),
  );
  writeFileSync(join(packageRoot, "openclaw.mjs"), "// baseline launcher\n");
  const dependencyFile = join(packageRoot, "node_modules", "fixture-dependency", "index.js");
  mkdirSync(dirname(dependencyFile), { recursive: true });
  writeFileSync(dependencyFile, "// baseline dependency\n");
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
  const updateFile = join(root, "update.json");
  const errorFile = join(root, "update.err");
  const observationRoot = join(root, "observation");
  const diagnosticsDir = join(observationRoot, "diagnostics");
  mkdirSync(diagnosticsDir, { recursive: true });
  const observationFile = join(diagnosticsDir, "process-123-exited.json");
  writeFileSync(
    observationFile,
    JSON.stringify({
      role: "doctor",
      packageVersion: candidateVersion,
      event: "exited",
      exitCode: 1,
    }),
  );
  const update = {
    status: "error",
    before: { version: baselineVersion },
    steps: [
      {
        name: "openclaw doctor",
        exitCode: 1,
        stdoutTail: "",
        stderrTail:
          "[openclaw] DoctorUpdateSchemaRefusalError: Doctor refused update-time schema repair",
      },
    ],
  };
  writeFileSync(errorFile, "");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [schemaCommand, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    });
  const prepared = run("prepare", baselineVersion, tarball, stateDir, snapshotFile, packageRoot);
  expect(prepared.status, prepared.stderr).toBe(0);
  function checkSchemaOutcome(
    exitCode = 1,
    installedVersion = baselineVersion,
    acceptedOutcome = "success",
  ) {
    writeFileSync(updateFile, JSON.stringify(update));
    return run(
      "assert",
      snapshotFile,
      String(exitCode),
      installedVersion,
      updateFile,
      errorFile,
      observationRoot,
      packageRoot,
      acceptedOutcome,
    );
  }
  return {
    prepared,
    check: checkSchemaOutcome,
    update,
    observationFile,
    stateDatabase,
    agentDatabase,
    packageRoot,
    dependencyFile,
    snapshotFile,
    candidateVersion,
  };
}

describe("published survivor schema outcome", () => {
  it.each([
    [0, "success", true],
    [1, "success", false],
    [0, "recoverable", true],
    [1, "recoverable", true],
    [2, "recoverable", false],
  ] as const)(
    "checks migrated schemas after exit %i classified as %s",
    (code, outcome, accepted) => {
      const lane = schemaFixture("2026.9.1");
      writeSchema(lane.stateDatabase, 16);
      const result = lane.check(code, lane.candidateVersion, outcome);
      expect(result.status, result.stderr).toBe(accepted ? 0 : 1);
    },
  );

  it.each([
    ["2026.9.2", 15, 19, "schema-refusal"],
    ["2026.9.2-rebuild.1", 15, 19, "schema-refusal"],
    ["2026.9.2", 16, 18, "schema-refusal"],
    ["2026.9.2", 16, 19, "success"],
    ["2026.9.1", 15, 18, "success"],
    ["2026.6.34", 0, 0, "success"],
    ["2026.9.3-beta.1", 15, 18, "success"],
    ["2026.9.3", 15, 18, "success"],
  ] as const)("requires %s with schemas %i/%i to report %s", (baseline, state, agent, expected) => {
    const lane = schemaFixture(baseline, state, agent);
    expect(lane.prepared.stdout.trim()).toBe(expected);
    if (expected === "success") {
      expect(lane.check().status).toBe(1);
      writeSchema(lane.stateDatabase, 16);
      writeSchema(lane.agentDatabase, 19);
      const result = lane.check(0, lane.candidateVersion);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("success");
    } else {
      const result = lane.check();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("schema-refusal");
    }
  });

  it("observes refusal without changing the baseline package or database bytes", () => {
    const lane = schemaFixture();
    const files = [lane.stateDatabase, lane.agentDatabase, join(lane.packageRoot, "openclaw.mjs")];
    const before = files.map((file) => readFileSync(file));
    const result = lane.check();
    expect(result.status, result.stderr).toBe(0);
    expect(files.map((file) => readFileSync(file))).toEqual(before);
  });

  it("expects success for a JSON-era baseline without creating SQLite state while observing it", () => {
    const lane = schemaFixture("2026.6.34", null, null);
    expect(lane.prepared.stdout.trim()).toBe("success");
    expect(JSON.parse(readFileSync(lane.snapshotFile, "utf8")).databases).toEqual([
      { kind: "state", relative: "state/openclaw.sqlite", userVersion: null },
    ]);
    expect(existsSync(lane.stateDatabase)).toBe(false);
    expect(existsSync(lane.agentDatabase)).toBe(false);
    writeSchema(lane.stateDatabase, 16);
    writeSchema(lane.agentDatabase, 19);
    const result = lane.check(0, lane.candidateVersion);
    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts the structured refusal emitted by JSON Doctor", () => {
    const lane = schemaFixture();
    lane.update.steps[0]!.stderrTail = "";
    lane.update.steps[0]!.stdoutTail = JSON.stringify({
      ok: false,
      error: { code: "update-schema-bump-unfenced" },
    });
    const result = lane.check();
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a successful update that deleted a baseline agent database", () => {
    const lane = schemaFixture("2026.9.1");
    writeSchema(lane.stateDatabase, 16);
    rmSync(lane.agentDatabase);
    const result = lane.check(0, lane.candidateVersion);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("baseline database missing after update");
  });

  it.each([
    [
      "state migrated",
      (lane: ReturnType<typeof schemaFixture>) => writeSchema(lane.stateDatabase, 16),
      "baseline databases",
    ],
    [
      "agent migrated",
      (lane: ReturnType<typeof schemaFixture>) => writeSchema(lane.agentDatabase, 20),
      "baseline databases",
    ],
    [
      "database lost",
      (lane: ReturnType<typeof schemaFixture>) => rmSync(lane.agentDatabase),
      "baseline databases",
    ],
    [
      "candidate bytes retained at the baseline version",
      (lane: ReturnType<typeof schemaFixture>) =>
        writeFileSync(join(lane.packageRoot, "openclaw.mjs"), "// candidate launcher\n"),
      "package bytes",
    ],
    [
      "changed installed dependency bytes",
      (lane: ReturnType<typeof schemaFixture>) =>
        writeFileSync(lane.dependencyFile, "// candidate dependency\n"),
      "package bytes",
    ],
    [
      "generic Doctor failure",
      (lane: ReturnType<typeof schemaFixture>) => {
        lane.update.steps[0]!.stderrTail = "Doctor failed; run doctor --fix";
      },
      "typed schema refusal",
    ],
    [
      "Doctor did not fail",
      (lane: ReturnType<typeof schemaFixture>) => {
        lane.update.steps[0]!.exitCode = 0;
      },
      "failed Doctor step",
    ],
    [
      "candidate Doctor did not exit",
      (lane: ReturnType<typeof schemaFixture>) => rmSync(lane.observationFile),
      "observed refusal exit",
    ],
  ] as const)("rejects %s", (_name, change, diagnostic) => {
    const lane = schemaFixture();
    change(lane);
    const result = lane.check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
  });

  it("rejects a successful exit or another installed version instead of refusal", () => {
    const lane = schemaFixture();
    expect(lane.check(0).stderr).toContain("status 1");
    expect(lane.check(1, "2026.9.3").stderr).toContain("previous package version");
  });
});
