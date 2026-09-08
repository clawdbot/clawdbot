import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { listUpdateRuns } from "../infra/update-run-ledger.js";
import { isPidAlive } from "../shared/pid-alive.js";
import {
  formatCliProcessFailure,
  runCliProcessChild,
  waitForCliProcessStderrMarker,
} from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixture = fileURLToPath(
  new URL("./update-finalization-output.test-support.ts", import.meta.url),
);
const doctorDiagnostics = [
  "OpenClaw doctor",
  "Doctor panel diagnostic",
  "Doctor workspace diagnostic",
  "Doctor console diagnostic",
  "Doctor complete.",
];
const scenarios = [
  "json",
  "inherited-json",
  "doctor-error",
  "plugin-error",
  "human",
  "human-plugin-error",
  "human-plugin-warning",
  "human-recovery-plugin-error",
];
const finalizeScenarios = [
  "json",
  "phase-hang",
  "completion-hang",
  "handle-hang",
  "borrowed-phase",
  "borrowed-output",
];

describe.each(["repair", "finalize"])("update %s process output", (command) => {
  // Both spellings share the finalization action; one matrix covers its output modes.
  it.each(command === "repair" ? scenarios : finalizeScenarios)(
    "%s preserves the output and exit contract without restarting",
    async (scenario) => {
      const root = tempDirs.make("openclaw-update-json-");
      const state = path.join(root, "state");
      const config = path.join(root, "openclaw.json");
      const workspace = path.join(root, "workspace");
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing isolated port");
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      expect(address.port).not.toBe(18789);
      await fs.mkdir(state);
      await fs.mkdir(workspace);
      await fs.writeFile(
        config,
        JSON.stringify({
          gateway: { mode: "local", port: address.port, auth: { mode: "none" } },
          plugins: { enabled: false, allow: [] },
          agents: { defaults: { workspace } },
          logging: { file: path.join(root, "openclaw.log") },
        }),
      );
      const json = !scenario.startsWith("human");
      const blockedPhase =
        scenario === "phase-hang"
          ? "configSnapshot"
          : scenario === "completion-hang"
            ? "completionCache"
            : undefined;
      const args = [
        "update",
        ...(scenario === "inherited-json" ? ["--json"] : []),
        command,
        "--channel",
        "dev",
        ...(scenario === "human-recovery-plugin-error" ? [] : ["--yes"]),
        "--no-restart",
        ...(blockedPhase ? [] : ["--timeout", scenario === "borrowed-phase" ? "1" : "9"]),
        ...(json && scenario !== "inherited-json" ? ["--json"] : []),
      ];
      const readRun = () =>
        listUpdateRuns({ limit: 1 }, { env: { HOME: root, OPENCLAW_STATE_DIR: state } })[0];
      let observedPhaseStart: ReturnType<typeof readRun> | undefined;
      const result = await runCliProcessChild({
        ...(scenario === "phase-hang"
          ? {
              interact: async (
                child: import("node:child_process").ChildProcessWithoutNullStreams,
              ) => {
                child.stdin.end();
                await waitForCliProcessStderrMarker(child, "fixture configSnapshot entered");
                try {
                  observedPhaseStart = readRun();
                } catch (error) {
                  throw new Error("Could not read the phase-start ledger", { cause: error });
                }
              },
            }
          : {}),
        nodeArgs: [
          "--import",
          "tsx",
          fixture,
          JSON.stringify(runtimeProcessEntrypoints),
          scenario,
          ...args,
        ],
        env: {
          ESBUILD_WORKER_THREADS: "0",
          PATH: path.dirname(process.execPath),
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: state,
          OPENCLAW_CONFIG_PATH: config,
          OPENCLAW_SERVICE_REPAIR_POLICY: "external",
          OPENCLAW_GATEWAY_PORT: String(address.port),
          XDG_CONFIG_HOME: path.join(root, "xdg-config"),
          XDG_DATA_HOME: path.join(root, "xdg-data"),
          XDG_CACHE_HOME: path.join(root, "xdg-cache"),
          XDG_STATE_HOME: path.join(root, "xdg-state"),
          XDG_RUNTIME_DIR: path.join(root, "xdg-runtime"),
          TMPDIR: root,
          NODE_DISABLE_COMPILE_CACHE: "1",
          NO_COLOR: "1",
          TERM: "dumb",
        },
      });
      const failure = formatCliProcessFailure({ reason: `${command} ${scenario}`, ...result });
      expect(result.signal, failure).toBeNull();
      expect(result.code, failure).toBe(
        scenario.endsWith("error") || scenario === "phase-hang" ? 1 : 0,
      );
      if (scenario.startsWith("borrowed-")) {
        expect(result.stderr, failure).toContain("Borrowed caller completed.");
        expect(result.stderr, failure).not.toContain("Process still alive after terminal output");
        if (scenario === "borrowed-phase") {
          const timing = JSON.parse(result.stdout).phaseTimings.find(
            (entry: { phase: string }) => entry.phase === "configSnapshot",
          );
          expect(timing, failure).toMatchObject({ outcome: "completed" });
          expect(timing.durationMs, failure).toBeGreaterThanOrEqual(1_000);
        }
      }
      if (blockedPhase) {
        if (scenario === "phase-hang") {
          expect(observedPhaseStart?.steps, failure).toContainEqual(
            expect.objectContaining({
              step: "finalize:configSnapshot",
              status: "in_progress",
              startedAtMs: expect.any(Number),
            }),
          );
        }
        const output = JSON.parse(result.stdout);
        expect(output).toMatchObject({
          status: scenario === "phase-hang" ? "failed" : "ok",
          restart: false,
        });
        if (scenario === "phase-hang") {
          expect(output.stuckPhase).toBe(blockedPhase);
          const pid = Number(await fs.readFile(path.join(root, "blocked-child.pid"), "utf8"));
          expect(output.childProcesses, failure).toContainEqual({
            pid,
            parentPid: expect.any(Number),
            command: expect.stringMatching(/^node(?:\.exe)?$/u),
          });
          expect(output.childProcessInspection, failure).toBe("complete");
          expect(result.stdout + result.stderr, failure).not.toContain("fixture-private-argument");
          const prerequisite = output.phaseTimings.find(
            (entry: { phase: string }) => entry.phase === "targetConfigValidation",
          );
          expect(prerequisite, failure).toMatchObject({ outcome: "completed" });
          expect(prerequisite.durationMs, failure).toBeGreaterThanOrEqual(1_000);
        } else {
          expect(output.stuckPhase).toBeUndefined();
          const pid = Number(await fs.readFile(path.join(root, "completion.pid"), "utf8"));
          expect(pid).toBeGreaterThan(0);
          expect(isPidAlive(pid)).toBe(false);
        }
        expect(output.phaseTimings).toContainEqual(
          expect.objectContaining({
            phase: blockedPhase,
            outcome: "failed",
            durationMs: expect.any(Number),
          }),
        );
        expect(result.stderr).toContain(`finalize:${blockedPhase}`);
        expect(readRun()).toMatchObject({
          status: scenario === "phase-hang" ? "failed" : "succeeded",
          steps: expect.arrayContaining([
            expect.objectContaining({
              step: `finalize:${blockedPhase}`,
              status: "failed",
              startedAtMs: expect.any(Number),
              endedAtMs: expect.any(Number),
            }),
          ]),
        });
        return;
      }
      if (scenario === "handle-hang") {
        expect(result.stderr).toContain("activeResources");
        expect(result.stderr).toContain("unsettledDisposers");
        const pid = Number(await fs.readFile(path.join(root, "blocked-child.pid"), "utf8"));
        const diagnostic = result.stderr
          .split("\n")
          .find((line) => line.includes("Process still alive after terminal output:"));
        expect(diagnostic, failure).toBeDefined();
        const payload = JSON.parse(diagnostic!.slice(diagnostic!.indexOf("{")));
        expect(payload.childProcesses, failure).toContainEqual({
          pid,
          parentPid: expect.any(Number),
          command: expect.stringMatching(/^node(?:\.exe)?$/u),
        });
        expect(payload.unsettledDisposers, failure).toContain("fixture-stdin-child");
        expect(result.stdout + result.stderr, failure).not.toContain("fixture-private-argument");
        expect(readRun()).toMatchObject({
          status: "succeeded",
          steps: expect.arrayContaining([
            expect.objectContaining({
              step: "finalize:exit",
              detail: expect.stringContaining("activeResources"),
            }),
          ]),
        });
      }
      const diagnostics = json ? result.stderr : result.stdout;
      for (const diagnostic of doctorDiagnostics) {
        expect(diagnostics, failure).toContain(diagnostic);
      }
      expect(diagnostics.match(/Doctor console diagnostic/gu), failure).toHaveLength(1);
      expect(result.stderr, failure).toContain("Doctor stderr diagnostic");
      if (scenario === "human-recovery-plugin-error") {
        expect(result.stdout, failure).toContain("Update finalization failed.");
        expect(result.stdout, failure).toContain("Interactive recovery completed.");
        expect(result.stderr, failure).not.toContain("Process still alive after terminal output");
        return;
      }
      const triageNotice = "Update failed. Entering triage...";
      if (!scenario.endsWith("error")) {
        expect(result.stdout + result.stderr, failure).not.toContain(triageNotice);
        expect(result.stdout + result.stderr, failure).not.toContain("triage-fixture-prompt.md");
      }
      if (!json) {
        const terminal =
          scenario === "human-plugin-error"
            ? "Update finalization failed."
            : scenario === "human-plugin-warning"
              ? "Update finalization completed with warnings."
              : "Update finalization completed.";
        if (scenario === "human-plugin-error") {
          expect(result.stdout, failure).toContain(terminal);
          const triageIndex = result.stdout.indexOf(triageNotice);
          const promptIndex = result.stdout.indexOf("Debugging prompt:");
          const guidanceIndex = result.stdout.indexOf("Ready-to-run agent handoffs:");
          expect(triageIndex, failure).toBeGreaterThan(result.stdout.indexOf(terminal));
          expect(promptIndex, failure).toBeGreaterThan(triageIndex);
          expect(guidanceIndex, failure).toBeGreaterThan(promptIndex);
          expect(result.stdout.trimEnd().endsWith("openclaw triage --run"), failure).toBe(true);
        } else {
          expect(result.stdout.trimEnd().endsWith(terminal), failure).toBe(true);
        }
        return;
      }
      // Parse the whole pipe: accepting a suffix would hide Clack's direct stdout writes.
      const output = JSON.parse(result.stdout);
      if (scenario.endsWith("error")) {
        expect(result.stderr, failure).toContain(triageNotice);
        expect(result.stderr, failure).toContain('"promptPath":');
        expect(result.stderr, failure).toContain("triage-fixture-prompt.md");
        expect(result.stderr, failure).not.toContain("Triage could not complete:");
        expect(result.stdout, failure).not.toContain("triage-fixture-prompt.md");
      }
      if (scenario === "doctor-error") {
        expect(output).toMatchObject({
          ok: false,
          error: { type: "cli_error", message: expect.stringContaining("Doctor repair failed") },
        });
      } else {
        expect(output).toMatchObject({
          status: scenario === "plugin-error" ? "error" : "ok",
          mode: "finalize",
          restart: false,
          channel: "dev",
          postUpdate: { doctor: { status: "ok" } },
        });
      }
    },
  );
});
