import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as realDelay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isProcessAlive, waitForDead, waitForPidFile } from "../../test/helpers/process-wait.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as cliBackends from "../plugins/cli-backends.runtime.js";
import * as processSupervisor from "../process/supervisor/index.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { SpawnInput } from "../process/supervisor/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { agentExecCommand } from "./agent-exec.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("agent exec command composition", () => {
  it("bounds blocked private-input construction through the shipped CLI command", async () => {
    const root = tempDirs.make("openclaw-agent-exec-service-construction-");
    const pidPath = path.join(root, "command.pid");
    const configPath = path.join(root, "openclaw.json");
    const createSecretData = vi.fn(() => Buffer.alloc(8 * 1024 * 1024, 97));
    // Claude's plugin-owned SDK bypasses the supervisor. A registered process backend
    // keeps the real command route and blocks construction on an unread secret pipe.
    vi.spyOn(cliBackends, "resolveRuntimeCliBackends").mockReturnValue([
      {
        id: "construction-cli",
        pluginId: "construction-test",
        config: {
          command: process.execPath,
          args: [
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
          ],
          input: "stdin",
          output: "text",
        },
        prepareExecution: () => ({
          beforeExecution: async () => {
            // Freeze at the backend's queue admission, after cold command preparation.
            // Real process readiness must precede advancing the construction deadline.
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          },
          secretInput: {
            fd: 3,
            fingerprint: "synthetic-construction",
            createData: createSecretData,
          },
        }),
      },
    ]);
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          defaults: {
            model: { primary: "construction-cli/model-a" },
            // The synthetic backend has no reasoning capability to discover.
            thinkingDefault: "off",
          },
        },
      }),
      "utf8",
    );

    const completed = await withEnvAsync(
      {
        NODE_DISABLE_COMPILE_CACHE: "1",
        OPENCLAW_SERVICE_MARKER: "openclaw",
      },
      async () => {
        const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        // POSIX relay cancellation loses cleanup identity. Keep that failed owner
        // local so shared-worker teardown cannot inherit its expected uncertainty.
        const supervisor = createProcessSupervisor();
        vi.spyOn(processSupervisor, "getProcessSupervisor").mockReturnValue(supervisor);
        const spawn = supervisor.spawn.bind(supervisor);
        const admitted = createDeferred<SpawnInput>();
        vi.spyOn(supervisor, "spawn").mockImplementation((input) => {
          const pending = spawn(input);
          admitted.resolve(input);
          return pending;
        });
        const result = agentExecCommand(
          "probe",
          { config: configPath, cwd: root, timeout: "1", json: true },
          runtime,
        );
        let commandPid: number | undefined;
        let input: SpawnInput | undefined;
        try {
          input = await Promise.race([
            admitted.promise,
            result.then((finished) => {
              throw new Error(
                `Command ended before supervisor admission: ${JSON.stringify(finished)}`,
              );
            }),
          ]);
          commandPid = await waitForPidFile(pidPath, 3_000, realDelay);
          expect(isProcessAlive(commandPid)).toBe(true);
          expect(createSecretData).toHaveBeenCalledOnce();
          expect(input).toMatchObject({
            mode: "child",
            backendId: "construction-cli",
            timeoutMs: 1_000,
          });
          const runId = expectDefined(input.runId, "command supervisor run ID");
          expect(supervisor.getRecord(runId)).toMatchObject({ state: "starting" });
          await vi.advanceTimersByTimeAsync(999);
          expect(supervisor.getRecord(runId)).toMatchObject({ state: "starting" });
          await vi.advanceTimersByTimeAsync(1);
          expect(supervisor.getRecord(runId)).toMatchObject({
            state: "exited",
            terminationReason: "overall-timeout",
          });
          vi.useRealTimers();
          const finished = await result;
          await waitForDead(commandPid, 5_000);
          return finished;
        } finally {
          vi.useRealTimers();
          if (input?.runId) {
            supervisor.cancel(input.runId);
          }
          if (commandPid && isProcessAlive(commandPid)) {
            process.kill(commandPid, "SIGKILL");
          }
          await result;
          const cleanup = supervisor.shutdown();
          // Windows uses a direct child; only POSIX loses the relay's cleanup authority.
          if (process.platform === "win32") {
            await expect(cleanup).resolves.toBeUndefined();
          } else {
            await expect(cleanup).rejects.toThrow("service child cleanup identity lost");
          }
        }
      },
    );
    expect(completed.exitCode).toBe(2);
    expect(completed.envelope).toMatchObject({
      ok: false,
      status: "timeout",
    });
  });
});
