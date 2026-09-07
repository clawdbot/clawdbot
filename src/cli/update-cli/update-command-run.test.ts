import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gatewayService from "../../daemon/service.js";
import * as systemdExec from "../../daemon/systemd-exec.js";
import {
  readSystemdServiceExecStart,
  resolveSystemdUnitPath,
} from "../../daemon/systemd-service-files.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import {
  beginUpdateRecovery,
  loadUpdateRecovery,
  UpdateRecoveryRequiredError,
} from "../../infra/update-run-recovery.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  admitUpdateCommandRun,
  completeUpdateCommandRun,
  failUpdateCommandRun,
  withUpdatePreviewSignals,
} from "./update-command-run.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "keeps restored-generation completion with its helper across CLI unwind (handoff=%s)",
  (handoff) => {
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", handoff ? "1" : undefined);
    const env = { OPENCLAW_STATE_DIR: dirs.make("update-rollback-owner-") };
    const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    const result = {
      status: "error" as const,
      mode: "npm" as const,
      durationMs: 1,
      steps: [],
      reason: "restart-unhealthy",
      before: { version: "2026.9.1" },
      after: { version: "2026.9.1" },
      recovery: {
        serviceRestartSafe: true as const,
        packageRollbackVerified: true as const,
        version: "2026.9.1",
      },
    };
    completeUpdateCommandRun(result, run);
    completeUpdateCommandRun(result, run);
    expect(getUpdateRun(run.runId, { env })).toMatchObject({
      status: handoff ? "running" : "failed",
      after: { version: "2026.9.1" },
    });
    if (handoff) {
      finishUpdateRun(run.runId, { status: "rolled-back", reason: result.reason }, { env });
      completeUpdateCommandRun(result, run);
      expect(getUpdateRun(run.runId, { env })?.status).toBe("rolled-back");
    }
  },
);

function pendingRecovery() {
  const root = dirs.make("update-admission-recovery-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  vi.stubEnv(UPDATE_RUN_ID_ENV, undefined);
  const env = { ...process.env };
  const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
  const from = { root, nodePath: process.execPath, version: "1.0.0", buildId: null };
  // This fixture owns every writer of its disposable state directory.
  const record = beginUpdateRecovery(
    { runId: run.runId, from, to: { ...from, version: "2.0.0" } },
    { assertCurrent() {} },
    { env },
  );
  closeOpenClawStateDatabaseForTest();
  const snapshot = () =>
    fs
      .readdirSync(root, { recursive: true })
      .map(String)
      .toSorted()
      .map((name) => {
        const filename = path.join(root, name);
        const stat = fs.statSync(filename);
        return {
          name,
          ino: stat.ino,
          mtime: stat.mtimeMs,
          mode: stat.mode,
          sha256: stat.isFile()
            ? createHash("sha256").update(fs.readFileSync(filename)).digest("hex")
            : null,
        };
      });
  return { root, run, record, snapshot };
}

it.each([
  { dryRun: true, reuseRunId: false },
  { dryRun: false, reuseRunId: true },
])(
  "refuses interrupted update admission without touching SQLite ($dryRun, $reuseRunId)",
  async ({ dryRun, reuseRunId }) => {
    const { root, run, record, snapshot } = pendingRecovery();
    if (reuseRunId) {
      vi.stubEnv(UPDATE_RUN_ID_ENV, run.runId);
    }
    const before = snapshot();
    await expect(
      admitUpdateCommandRun({ opts: { dryRun }, root }).then(() => "admitted"),
    ).rejects.toBeInstanceOf(UpdateRecoveryRequiredError);
    expect(snapshot()).toEqual(before);
    expect(loadUpdateRecovery(run.runId, { env: run.env })).toEqual(record);
  },
);

it.each(["displaced", "replacement", "both", "unreadable"] as const)(
  "blocks admission when publication has no canonical DB (%s)",
  async (familyState) => {
    const { root, run, snapshot } = pendingRecovery();
    vi.stubEnv(UPDATE_RUN_ID_ENV, run.runId);
    const file = path.join(root, "state", "openclaw.sqlite");
    const family = path.join(path.dirname(file), `.openclaw-restore-${randomUUID()}-0`);
    fs.mkdirSync(family);
    fs.renameSync(file, path.join(family, "displaced"));
    if (familyState === "replacement") {
      fs.renameSync(path.join(family, "displaced"), path.join(family, "replacement"));
    } else if (familyState === "both") {
      fs.copyFileSync(path.join(family, "displaced"), path.join(family, "replacement"));
    } else if (familyState === "unreadable") {
      fs.writeFileSync(path.join(family, "displaced"), "incomplete database");
    }
    const before = snapshot();
    await expect(admitUpdateCommandRun({ opts: {}, root }).then(() => "admitted")).rejects.toThrow(
      "Interrupted shared-database publication requires reconciliation",
    );
    expect(fs.existsSync(file)).toBe(false);
    expect(snapshot()).toEqual(before);
  },
);

it.each(["ok", "error"] as const)(
  "does not complete an operationally pending update from diagnostic %s",
  (status) => {
    const { run, record, snapshot } = pendingRecovery();
    const before = snapshot();
    const result = {
      status,
      mode: "npm" as const,
      durationMs: 1,
      steps: [],
      ...(status === "error" ? { reason: "primary-failure" } : {}),
    };
    const completed = completeUpdateCommandRun(result, run);
    expect(completed.status).toBe("error");
    expect(completed.reason).toBe(
      status === "error" ? "primary-failure" : "update-recovery-pending",
    );
    failUpdateCommandRun(new Error("outer unwind"), run);
    expect(snapshot()).toEqual(before);
    expect(getUpdateRun(run.runId, { env: run.env })?.status).toBe("running");
    expect(loadUpdateRecovery(run.runId, { env: run.env })).toEqual(record);
  },
);

it("continues normal history admission when no operational update is pending", async () => {
  const root = dirs.make("update-admission-empty-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv(UPDATE_RUN_ID_ENV, undefined);
  const run = await admitUpdateCommandRun({ opts: { dryRun: true }, root });
  expect(getUpdateRun(run.runId, { env: run.env })?.status).toBe("running");
});

// Real signals terminate a separate process; the parent never emits into Vitest.
it.skipIf(process.platform === "win32").each([
  { signal: "SIGINT", mode: "fresh" },
  { signal: "SIGTERM", mode: "fresh" },
  { signal: "SIGINT", mode: "repeat" },
  { signal: "SIGINT", mode: "inherited" },
  { signal: "SIGINT", mode: "handoff" },
  { signal: "SIGINT", mode: "pending" },
  { signal: "SIGINT", mode: "changed" },
  { signal: "SIGINT", mode: "completed" },
  { signal: "SIGINT", mode: "missing" },
] as const)(
  "disposes only the owned unchanged preview before $signal exit ($mode)",
  async ({ signal, mode }) => {
    const root = dirs.make("update-preview-signal-");
    const caller = path.join(root, "preview.mjs");
    fs.writeFileSync(
      caller,
      `
      import fs from 'node:fs';
      import { registerSignalExitGate } from ${JSON.stringify(new URL("../signal-exit-barrier.ts", import.meta.url).href)};
      import { createUpdateRun, finishUpdateRun, getUpdateRun, recordUpdateRunPhase } from ${JSON.stringify(new URL("../../infra/update-run-ledger.ts", import.meta.url).href)};
      import { beginUpdateRecovery } from ${JSON.stringify(new URL("../../infra/update-run-recovery.ts", import.meta.url).href)};
      import { closeOpenClawStateDatabaseForTest } from ${JSON.stringify(new URL("../../state/openclaw-state-db.ts", import.meta.url).href)};
      import { admitUpdateCommandRun, withUpdatePreviewSignals } from ${JSON.stringify(new URL("./update-command-run.ts", import.meta.url).href)};
      const opts = { dryRun: true };
      const mode = ${JSON.stringify(mode)};
      if (mode === 'inherited') process.env.OPENCLAW_UPDATE_RUN_ID = createUpdateRun({trigger:'cli'}).runId;
      const run = await admitUpdateCommandRun({ opts, root: ${JSON.stringify(root)} });
      await withUpdatePreviewSignals({ ...opts, run }, async () => {
        const sibling = createUpdateRun({ trigger: 'cli' });
        if (mode === 'repeat') {
          registerSignalExitGate(new Promise((resolve) => process.once('message', resolve)));
          process.once('SIGINT', () => process.send('interrupted'));
        }
        if (mode === 'handoff') process.env.OPENCLAW_UPDATE_RUN_HANDOFF = '1';
        if (mode === 'pending' || mode === 'missing') {
          const from = { root: ${JSON.stringify(root)}, nodePath: process.execPath, version: '1.0.0', buildId: null };
          beginUpdateRecovery({ runId: run.runId, from, to: { ...from, version: '2.0.0' } }, { assertCurrent() {} }, { env: run.env });
        }
        if (mode === 'changed') recordUpdateRunPhase(run.runId, 'staging');
        if (mode === 'completed') finishUpdateRun(run.runId, { status: 'skipped', reason: 'dry-run' });
        const expected = getUpdateRun(run.runId);
        if (mode === 'missing') {
          closeOpenClawStateDatabaseForTest();
          const base = ${JSON.stringify(path.join(root, "state"))};
          const family = base + '/.openclaw-restore-00000000-0000-4000-8000-000000000001-0';
          fs.mkdirSync(family);
          fs.renameSync(base + '/openclaw.sqlite', family + '/displaced');
        }
        process.send({ runId: run.runId, expected, sibling });
        await new Promise(() => setInterval(() => {}, 1000));
      });
    `,
    );
    const child = spawn(process.execPath, ["--import", "./scripts/tsx.mjs", caller], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_UPDATE_RUN_ID: undefined,
        OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
        OPENCLAW_UPDATE_POST_CORE: undefined,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const closed = once(child, "close");
    let releaseGate: ReturnType<typeof setTimeout> | undefined;
    try {
      const message = await Promise.race([
        once(child, "message").then(
          ([payload]) =>
            payload as {
              runId: string;
              expected: ReturnType<typeof getUpdateRun>;
              sibling: ReturnType<typeof createUpdateRun>;
            },
        ),
        closed.then(() => {
          throw new Error(`Preview exited before ready: ${stderr}`);
        }),
      ]);
      const firstSignal = mode === "repeat" ? once(child, "message") : undefined;
      expect(child.kill(signal)).toBe(true);
      if (firstSignal) {
        await firstSignal;
        expect(child.kill(signal)).toBe(true);
        // Hold cleanup across actual repeat-signal delivery; no metadata timeout is involved.
        releaseGate = setTimeout(() => {
          if (child.connected) {
            child.send("release");
          }
        }, 100);
      }
      const [code, exitSignal] = await closed;
      expect(code ?? (exitSignal === "SIGINT" ? 130 : 143)).toBe(signal === "SIGINT" ? 130 : 143);
      const options =
        mode === "missing"
          ? {
              path: path.join(
                root,
                "state",
                ".openclaw-restore-00000000-0000-4000-8000-000000000001-0",
                "displaced",
              ),
            }
          : { env: { OPENCLAW_STATE_DIR: root } };
      const record = getUpdateRun(message.runId, options);
      if (mode === "fresh" || mode === "repeat") {
        expect(record).toMatchObject({
          status: "skipped",
          phase: "finished",
          reason: "interrupted",
        });
        expect(record?.finishedAtMs).toEqual(expect.any(Number));
        expect(record?.steps.some((step) => step.status === "in_progress")).toBe(false);
      } else {
        expect(record).toEqual(message.expected);
      }
      expect(getUpdateRun(message.sibling.runId, options)).toEqual(message.sibling);
      if (mode === "missing") {
        for (const suffix of ["", "-wal", "-shm"]) {
          expect(fs.existsSync(path.join(root, "state", `openclaw.sqlite${suffix}`))).toBe(false);
        }
      }
    } finally {
      clearTimeout(releaseGate);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
    }
  },
  60_000,
);

it.each([false, true])(
  "removes preview signal ownership on ordinary unwind (throws=%s)",
  async (throws) => {
    const root = dirs.make("update-preview-cleanup-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv(UPDATE_RUN_ID_ENV, undefined);
    const run = await admitUpdateCommandRun({ opts: { dryRun: true }, root });
    const before = [process.listeners("SIGINT"), process.listeners("SIGTERM")];
    const operation = withUpdatePreviewSignals({ dryRun: true, run }, async () => {
      if (throws) {
        throw new Error("preview error");
      }
      finishUpdateRun(run.runId, { status: "skipped", reason: "dry-run" }, { env: run.env });
      return 42;
    });
    if (throws) {
      await expect(operation).rejects.toThrow("preview error");
    } else {
      await expect(operation).resolves.toBe(42);
    }
    expect([process.listeners("SIGINT"), process.listeners("SIGTERM")]).toEqual(before);
  },
);

it.each([
  "owned",
  "owned-pending",
  "foreign",
  "absent",
  "unloaded-local",
  "unloaded-global",
  "denied",
  "timeout",
  "malformed",
  "unresolved-root",
] as const)("admits only resolved loaded service ownership (%s)", async (scenario) => {
  const home = dirs.make("update-loaded-admission-");
  const callerState = path.join(home, ".openclaw-caller");
  const serviceState = path.join(home, ".openclaw-service");
  const root = path.join(home, "package");
  const foreignRoot = path.join(home, "foreign");
  for (const packageRoot of [root, foreignRoot]) {
    fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "openclaw" }));
    fs.writeFileSync(path.join(packageRoot, "dist", "entry.js"), "// fixture");
  }
  vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: home });
  for (const key of [
    "OPENCLAW_HOME",
    "OPENCLAW_SYSTEMD_UNIT",
    "OPENCLAW_LAUNCHD_LABEL",
    "OPENCLAW_WINDOWS_TASK_NAME",
    "OPENCLAW_SUPERVISOR_MODE",
    UPDATE_RUN_ID_ENV,
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_PROFILE", "caller");
  vi.stubEnv("OPENCLAW_STATE_DIR", callerState);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(callerState, "openclaw.json"));
  const serviceEnv = {
    ...process.env,
    OPENCLAW_PROFILE: "service",
    OPENCLAW_STATE_DIR: serviceState,
    OPENCLAW_CONFIG_PATH: path.join(serviceState, "openclaw.json"),
  };
  let pending: ReturnType<typeof beginUpdateRecovery> | undefined;
  if (scenario === "owned-pending") {
    const runId = createUpdateRun({ trigger: "cli" }, { env: serviceEnv }).runId;
    const from = { root, nodePath: process.execPath, version: "1.0.0", buildId: null };
    pending = beginUpdateRecovery(
      { runId, from, to: { ...from, version: "2.0.0" } },
      { assertCurrent() {} },
      { env: serviceEnv },
    );
    closeOpenClawStateDatabaseForTest();
  }
  const sourcePath = resolveSystemdUnitPath(process.env);
  if (scenario === "unloaded-local") {
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(
      sourcePath,
      `[Service]\nExecStart=${process.execPath} ${root}/dist/entry.js gateway\n`,
    );
  }
  const snapshot = () =>
    fs
      .readdirSync(home, { recursive: true })
      .map(String)
      .toSorted()
      .map((name) => {
        const filename = path.join(home, name);
        const stat = fs.statSync(filename);
        return [
          name,
          stat.ino,
          stat.mtimeMs,
          stat.mode,
          stat.isFile()
            ? createHash("sha256").update(fs.readFileSync(filename)).digest("hex")
            : null,
        ];
      });
  const before = snapshot();
  const command =
    scenario === "unresolved-root"
      ? ["opaque-launcher"]
      : [
          process.execPath,
          path.join(scenario === "foreign" ? foreignRoot : root, "dist", "entry.js"),
          "gateway",
        ];
  const response = (values: { type: string; data: unknown }[]) => ({
    code: 0,
    termination: "exit" as const,
    stderr: "",
    stdout: values.map((value) => JSON.stringify(value)).join("\n"),
  });
  const bus = vi.spyOn(systemdExec, "execBusctlUser").mockImplementation(async (_env, args) => {
    if (scenario === "denied" || scenario === "timeout") {
      return {
        code: 1,
        termination: scenario === "timeout" ? "timeout" : "exit",
        stdout: "",
        stderr: scenario === "timeout" ? "inspection timed out" : "Call failed: Permission denied",
      };
    }
    if (scenario === "malformed") {
      return { code: 0, termination: "exit", stdout: "not json", stderr: "" };
    }
    if (["absent", "unloaded-local", "unloaded-global"].includes(scenario)) {
      if (args.includes("GetUnitFileState") && scenario === "unloaded-global") {
        return response([{ type: "s", data: ["disabled"] }]);
      }
      const unit = "openclaw-gateway-caller.service";
      return {
        code: 1,
        termination: "exit",
        stdout: "",
        stderr: args.includes("GetUnitFileState")
          ? `Call failed: Unit file ${unit} does not exist.`
          : `Call failed: Unit ${unit} ${args.includes("GetUnit") ? "not loaded" : "not found"}.`,
      };
    }
    if (args.includes("GetUnit") || args.includes("LoadUnit")) {
      return response([{ type: "o", data: ["/org/freedesktop/systemd1/unit/gateway"] }]);
    }
    if (args.includes("FragmentPath")) {
      return response([
        { type: "s", data: sourcePath },
        { type: "as", data: [] },
        { type: "b", data: false },
        { type: "s", data: "loaded" },
      ]);
    }
    return response([
      { type: "a(sasbttttuii)", data: [[command[0], command, false, 0, 0, 0, 0, 0, 0, 0]] },
      { type: "s", data: "" },
      {
        type: "as",
        data: Object.entries(serviceEnv)
          .filter(([key]) =>
            ["OPENCLAW_PROFILE", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"].includes(key),
          )
          .map(([key, value]) => `${key}=${value}`),
      },
      { type: "a(sb)", data: [] },
      { type: "as", data: [] },
    ]);
  });
  // Use the real manager reader on every platform; only the native bus is simulated.
  const service = gatewayService.resolveGatewayService();
  vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue({
    ...service,
    readCommand: readSystemdServiceExecStart,
  });
  if (scenario === "owned" || scenario === "foreign" || scenario === "absent") {
    const run = await admitUpdateCommandRun({ opts: {}, root });
    const expectedState = scenario === "owned" ? serviceState : callerState;
    expect(run.env.OPENCLAW_STATE_DIR).toBe(expectedState);
    expect(run.env.OPENCLAW_PROFILE).toBe(scenario === "owned" ? "service" : "caller");
    expect(getUpdateRun(run.runId, { env: run.env })?.status).toBe("running");
    expect(
      fs.existsSync(path.join(scenario === "owned" ? callerState : serviceState, "state")),
    ).toBe(false);
  } else {
    await expect(
      admitUpdateCommandRun({ opts: {}, root }).then(() => "admitted"),
    ).rejects.toThrow();
    expect(snapshot()).toEqual(before);
    if (pending) {
      expect(loadUpdateRecovery(pending.runId, { env: serviceEnv })).toEqual(pending);
    }
  }
  expect(bus).toHaveBeenCalled();
  expect(bus.mock.calls.every(([, args]) => !args.includes("LoadUnit"))).toBe(true);
});
