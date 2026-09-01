import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveFutureConfigActionBlock } from "../../config/future-version-guard.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import {
  loadInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "../../plugins/installed-plugin-index-records.js";
import { runExec } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { VERSION } from "../../version.js";

const mocks = vi.hoisted(() => ({
  entrypoint: vi.fn(),
  root: vi.fn(),
  plugins: vi.fn<typeof import("./update-command-plugins.js").updatePluginsAfterCoreUpdate>(),
  restart: vi.fn(async () => true),
  print: vi.fn(),
}));

vi.mock("../../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: mocks.entrypoint,
}));
vi.mock("./update-command-plugins.js", () => ({ updatePluginsAfterCoreUpdate: mocks.plugins }));
vi.mock("./progress.js", () => ({ printResult: mocks.print }));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveUpdateRoot: mocks.root,
  tryWriteCompletionCache: vi.fn(async () => "skipped"),
}));
vi.mock("./update-command-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service.js")>()),
  maybeRestartService: mocks.restart,
  tryInstallShellCompletion: vi.fn(),
}));

import { updateFinalizeCommand } from "./update-command-finalize.js";
import type { LeaseScenario } from "./update-command-lease.test-support.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";
import { finishUpdate } from "./update-command-post-update.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";

const pluginResult: PostCorePluginUpdateResult = {
  status: "ok",
  changed: true,
  sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
};
type Lane = LeaseScenario["lane"];
let state: OpenClawTestState;
let entrypoint: string;

beforeEach(async () => {
  vi.clearAllMocks();
  state = await createOpenClawTestState({
    label: "update-lease",
    env: {
      OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
      OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: undefined,
      OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH: undefined,
      OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH: undefined,
      OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL: undefined,
      OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: undefined,
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: undefined,
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: undefined,
      OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART: undefined,
    },
  });
  await state.writeConfig({ plugins: { enabled: false }, update: { channel: "stable" } });
  await fs.writeFile(state.path("package.json"), JSON.stringify({ version: "1.0.0" }));
  entrypoint = await state.writeText(
    "entry.mjs",
    `
    import { tsImport } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};
    const { runUpdateLeaseChild } = await tsImport(${JSON.stringify(new URL("./update-command-lease.test-support.ts", import.meta.url).href)}, { parentURL: import.meta.url, tsconfig: ${JSON.stringify(path.resolve("tsconfig.json"))} });
    await runUpdateLeaseChild();
  `,
  );
  mocks.entrypoint.mockResolvedValue(entrypoint);
  mocks.root.mockResolvedValue(state.root);
  mocks.plugins.mockReset().mockResolvedValue(pluginResult);
  vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await state.cleanup();
});

async function writeScenario(
  lane: Lane,
  scenario: Omit<LeaseScenario, "lane"> = {},
): Promise<void> {
  await state.writeJson("scenario.json", { ...scenario, lane });
}

async function invoke(lane: Lane): Promise<void> {
  if (lane === "resume") {
    return resumePostCoreUpdate({
      root: state.root,
      channel: "stable",
      opts: { json: true, yes: true },
      timeoutMs: 15_000,
    });
  }
  if (lane === "repair") {
    return updateFinalizeCommand({
      json: true,
      yes: true,
      restart: false,
      timeout: "15",
      deferCompletionCache: true,
    });
  }
  return finishUpdate({
    result: {
      status: "ok",
      mode: "npm",
      root: state.root,
      before: { version: "2.0.0" },
      after: { version: "1.0.0" },
      steps: [],
      durationMs: 1,
    },
    root: state.root,
    installKindChanged: false,
    configSnapshot: await readConfigFileSnapshot({ skipPluginValidation: true }),
    requestedChannel: null,
    storedChannel: "stable",
    channel: "stable",
    downgradeRisk: true,
    shouldRestart: false,
    opts: { json: true, yes: true },
    showProgress: false,
    ownedManagedUpdateEnv: { ...process.env },
    controlPlaneUpdateSentinelMeta: null,
    preUpdatePluginInstallRecords: { stale: { source: "path", sourcePath: state.path("stale") } },
    startedAt: Date.now(),
    updateStepTimeoutMs: 15_000,
  });
}

async function events(): Promise<string[]> {
  return (await fs.readFile(state.statePath("events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const event = JSON.parse(line) as { event: string; pid: number };
      expect(event.pid).not.toBe(process.pid);
      return event.event;
    });
}

function expectDoctorDiagnostics(): void {
  expect(defaultRuntime.log).not.toHaveBeenCalledWith(expect.stringContaining("doctor fixture"));
  expect(defaultRuntime.error).toHaveBeenCalledWith("doctor fixture output");
  expect(defaultRuntime.error).toHaveBeenCalledWith(
    expect.stringContaining("doctor fixture diagnostic"),
  );
}

function expectSuccess(lane: Lane): void {
  expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  const output =
    lane === "current-process"
      ? mocks.print.mock.lastCall?.[0]
      : vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0];
  expect(output).toMatchObject({ status: "ok", postUpdate: { plugins: { status: "ok" } } });
  expectDoctorDiagnostics();
}

describe("update orchestration lifecycle ownership", () => {
  it.each(["resume", "current-process", "repair"] as const)(
    "%s releases plugin ownership for fresh doctor without delegating Gateway activation",
    async (lane) => {
      await writeScenario(lane, {
        hostVersion: lane === "repair" ? undefined : "1.0.0",
      });
      if (lane === "current-process") {
        vi.stubEnv("OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION", "1");
        vi.stubEnv("OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR", "1");
      }
      mocks.plugins.mockImplementationOnce(async () => {
        const result = await runExec(process.execPath, [entrypoint, "probe"], {
          timeoutMs: 15_000,
        });
        expect(result.stdout).toBe("excluded");
        return pluginResult;
      });
      await invoke(lane);
      expectSuccess(lane);
      expect(process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION).toBe(
        lane === "current-process" ? "1" : undefined,
      );
      expect(await events()).toEqual([
        ...(lane === "current-process" ? [] : ["pre-attempt", "pre-acquired"]),
        "post-attempt",
        "post-acquired",
        "validate",
        "readiness",
      ]);
      if (lane === "current-process") {
        expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBeUndefined();
        expect(mocks.restart).toHaveBeenCalledWith(
          expect.objectContaining({ shouldRestart: false }),
        );
      }
      expect(mocks.plugins).toHaveBeenCalledOnce();
      const after = await runExec(process.execPath, [entrypoint, "probe"], { timeoutMs: 15_000 });
      expect(after.stdout).toBe("acquired");
    },
  );

  it.each(["current-process", "repair"] as const)(
    "%s reloads config and records after a competing writer commits",
    async (lane) => {
      await writePersistedInstalledPluginIndexInstallRecords({ old: { source: "path" } });
      expect(await loadInstalledPluginIndexInstallRecords()).toHaveProperty("old");
      const writerRecords: Record<string, PluginInstallRecord> = {
        current: { source: "path", sourcePath: state.path("current") },
      };
      await writeScenario(lane, {
        writerConfig: {
          plugins: { enabled: false },
          update: { channel: "beta" },
          gateway: { port: 19002 },
        },
        writerRecords,
      });
      const acquired = createDeferred();
      const completed = createDeferred();
      const child = spawn(process.execPath, [entrypoint, "writer"], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      if (!child.stderr) {
        throw new Error("writer stderr pipe was not created");
      }
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("message", () => acquired.resolve());
      child.once("error", (error) => {
        acquired.reject(error);
        completed.reject(error);
      });
      child.once("close", (code) => {
        if (code === 0) {
          completed.resolve();
        } else {
          const error = new Error(`writer exited ${code}: ${stderr}`);
          acquired.reject(error);
          completed.reject(error);
        }
      });
      void completed.promise.catch(() => {});
      try {
        await acquired.promise;
        const update = invoke(lane);
        void update.catch(() => {});
        child.send("commit");
        await completed.promise;
        await update;
        expectSuccess(lane);
        expect(mocks.plugins).toHaveBeenCalledWith(
          expect.objectContaining({
            configSnapshot: expect.objectContaining({
              config: expect.objectContaining({
                gateway: expect.objectContaining({ port: 19002 }),
              }),
            }),
            pluginInstallRecords: writerRecords,
          }),
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await completed.promise.catch(() => {});
      }
    },
  );

  it.each([false, true])(
    "resume reads the doctor's committed generation (empty=%s)",
    async (empty) => {
      const old = { old: { source: "path" as const } };
      await writePersistedInstalledPluginIndexInstallRecords(old);
      expect(await loadInstalledPluginIndexInstallRecords()).toEqual(old);
      const recordsPath = await state.writeJson("forwarded.json", old);
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH", recordsPath);
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS", String(Date.now()));
      const current: Record<string, PluginInstallRecord> = empty
        ? {}
        : { current: { source: "path" } };
      await writeScenario("resume", {
        doctorWrites: true,
        writerConfig: { plugins: { enabled: false }, gateway: { port: 19003 } },
        writerRecords: current,
      });
      await invoke("resume");
      expectSuccess("resume");
      expect(mocks.plugins).toHaveBeenCalledWith(
        expect.objectContaining({
          configSnapshot: expect.objectContaining({
            config: expect.objectContaining({ gateway: expect.objectContaining({ port: 19003 }) }),
          }),
          pluginInstallRecords: current,
        }),
      );
      expect(await events()).toEqual([
        "pre-attempt",
        "pre-acquired",
        "writer-committed",
        "post-attempt",
        "post-acquired",
        "validate",
        "readiness",
      ]);
    },
  );

  it.each(["resume", "repair"] as const)(
    "%s does not run a final doctor when no plugins changed",
    async (lane) => {
      await writeScenario(lane);
      mocks.plugins.mockResolvedValueOnce({ ...pluginResult, changed: false });
      await invoke(lane);
      expectSuccess(lane);
      expect(await events()).toEqual(["pre-attempt", "pre-acquired", "readiness"]);
    },
  );

  it.each(["resume", "current-process", "repair"] as const)(
    "%s retains strict fresh validation after releasing the lease",
    async (lane) => {
      await writeScenario(lane, { invalidConfig: true });
      if (lane === "current-process") {
        await expect(invoke(lane)).rejects.toMatchObject({
          name: "UpdateCommandFailure",
          exitCode: 1,
        });
      } else {
        await invoke(lane);
      }
      const output =
        lane === "current-process"
          ? mocks.print.mock.lastCall?.[0]
          : vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0];
      expect(output).toMatchObject({
        status: "error",
        postUpdate: { plugins: { reason: "post-plugin-doctor-invalid-config" } },
      });
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(await events()).toContain("post-acquired");
      expect((await events()).at(-1)).toBe("validate");
      if (lane === "repair") {
        expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      }
    },
  );

  it("repair persists a requested channel before its fresh doctor and retains timings", async () => {
    await writeScenario("repair", { preDoctorChannel: "beta" });
    await updateFinalizeCommand({
      channel: "beta",
      json: true,
      yes: true,
      restart: false,
      deferCompletionCache: true,
    });
    expectSuccess("repair");
    expect(await events()).toContain("pre-acquired");
    expect(vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0]).toMatchObject({
      channel: "beta",
      restart: false,
      phaseTimings: [
        "targetConfigValidation",
        "configSnapshot",
        "doctor",
        "plugins",
        "targetConfigConvergence",
        "completionCache",
      ].map((phase) =>
        expect.objectContaining({
          phase,
          outcome: phase === "completionCache" ? "deferred" : "completed",
        }),
      ),
    });
  });

  it.each(["resume", "repair"] as const)(
    "%s propagates a pre-plugin doctor failure before parent mutation",
    async (lane) => {
      await writeScenario(lane, { failDoctor: "pre" });
      const resultPath = state.path("failed-post-core.json");
      if (lane === "resume") {
        vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", resultPath);
      }
      await expect(invoke(lane)).rejects.toThrow("doctor fixture failure");
      expect(mocks.plugins).not.toHaveBeenCalled();
      expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
      expectDoctorDiagnostics();
      expect(await events()).toEqual(["pre-attempt", "pre-acquired"]);
      if (lane === "resume") {
        const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
        expect(result).toMatchObject({
          status: "failed",
          error: expect.stringContaining("doctor fixture failure"),
        });
        expect(result.error).not.toContain(state.root);
        const probe = await runExec(process.execPath, [entrypoint, "probe"], { timeoutMs: 15_000 });
        expect(probe.stdout).toBe("acquired");
      }
    },
  );

  it("retains a final doctor failure while activating a strictly valid install", async () => {
    await writeScenario("current-process", { failDoctor: "post", hostVersion: "1.0.0" });
    await expect(invoke("current-process")).rejects.toMatchObject({
      name: "UpdateCommandFailure",
      exitCode: 1,
    });
    expect(mocks.print.mock.lastCall?.[0]).toMatchObject({
      status: "error",
      postUpdate: { plugins: { reason: "post-plugin-doctor-execution-failed" } },
    });
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(mocks.restart).toHaveBeenCalledOnce();
    expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBeUndefined();
    expectDoctorDiagnostics();
    expect(await events()).toEqual(["post-attempt", "post-acquired", "validate", "readiness"]);
  });

  it.each([
    {
      lane: "resume" as const,
      failure: "finding" as const,
      reason: "post-plugin-update-readiness-failed",
    },
    {
      lane: "resume" as const,
      failure: "execution" as const,
      reason: "post-plugin-update-readiness-execution-failed",
    },
    {
      lane: "current-process" as const,
      failure: "finding" as const,
      reason: "post-plugin-update-readiness-failed",
    },
    {
      lane: "current-process" as const,
      failure: "execution" as const,
      reason: "post-plugin-update-readiness-execution-failed",
    },
    {
      lane: "repair" as const,
      failure: "finding" as const,
      reason: "post-plugin-update-readiness-failed",
    },
    {
      lane: "repair" as const,
      failure: "execution" as const,
      reason: "post-plugin-update-readiness-execution-failed",
    },
  ])(
    "$lane leaves the Gateway stopped after a readiness $failure",
    async ({ lane, failure, reason }) => {
      await writeScenario(lane, {
        readinessFailure: failure,
        hostVersion: lane === "repair" ? undefined : "1.0.0",
      });

      if (lane === "current-process") {
        await expect(invoke(lane)).rejects.toMatchObject({
          name: "UpdateCommandFailure",
          exitCode: 1,
        });
      } else {
        await invoke(lane);
      }

      const output =
        lane === "current-process"
          ? mocks.print.mock.lastCall?.[0]
          : vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0];
      expect(output).toMatchObject({
        status: "error",
        postUpdate: { plugins: { reason } },
      });
      if (lane === "current-process") {
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
      } else {
        expect(defaultRuntime.exit).toHaveBeenCalledWith(lane === "resume" ? 0 : 1);
      }
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(await events()).toEqual([
        ...(lane === "current-process" ? [] : ["pre-attempt", "pre-acquired"]),
        "post-attempt",
        "post-acquired",
        "validate",
        "readiness",
      ]);
    },
  );

  it.each([
    { lane: "resume", valid: true },
    { lane: "repair", valid: true },
    { lane: "resume", valid: false },
    { lane: "repair", valid: false },
  ] as const)(
    "$lane preserves downgrade startup eligibility after a Doctor error (valid=$valid)",
    async ({ lane, valid }) => {
      const futureVersion = "2099.1.1";
      await state.writeConfig({
        meta: { lastTouchedVersion: futureVersion },
        plugins: { enabled: false },
        update: { channel: "stable" },
        gateway: { port: valid ? 19004 : -1 },
      });
      await writeScenario(lane, { failDoctor: "post", invalidConfig: !valid });

      await invoke(lane);

      expect(vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0]).toMatchObject({
        status: "error",
        postUpdate: {
          plugins: {
            reason: valid
              ? "post-plugin-doctor-execution-failed"
              : "post-plugin-doctor-invalid-config",
          },
        },
      });
      const persisted = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
      expect(persisted.meta?.lastTouchedVersion).toBe(valid ? VERSION : futureVersion);
      expect(persisted.update?.channel).toBe("stable");
      const startupBlock = resolveFutureConfigActionBlock({
        action: "start gateway service",
        config: persisted,
        env: {},
      });
      expect(startupBlock === null).toBe(valid);
      expect(await events()).toEqual([
        "pre-attempt",
        "pre-acquired",
        "post-attempt",
        "post-acquired",
        "validate",
        ...(valid ? ["readiness"] : []),
      ]);
    },
  );
});
