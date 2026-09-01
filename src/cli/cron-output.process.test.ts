import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const summaryBytes = 128 * 1024;
const sentinel = "\nEND-CRON-SUMMARY\n";
const summary = "x".repeat(summaryBytes - sentinel.length) + sentinel;

describe("cron process output", () => {
  it.each([
    { name: "wait success", args: ["run", "job-1", "--wait"], exitCode: 0, kind: "wait" },
    {
      name: "wait failure",
      args: ["run", "job-1", "--wait", "--json"],
      exitCode: 1,
      kind: "wait",
    },
    { name: "queued run", args: ["run", "job-1"], exitCode: 0, kind: "admission" },
    { name: "not-due run", args: ["run", "job-1", "--due"], exitCode: 1, kind: "admission" },
    { name: "run history", args: ["runs", "--id", "job-1"], exitCode: 0, kind: "history" },
    { name: "human error", args: ["show", "missing-job"], exitCode: 1, kind: "error" },
  ])(
    "drains output and preserves the exit code for $name",
    ({ args, exitCode, kind }) => {
      const root = tempDirs.make("openclaw-cron-output-");
      const sourceUrl = (relative: string) => new URL(relative, import.meta.url).href;
      const status = exitCode === 0 ? "ok" : "error";
      const completionStatus = exitCode === 0 ? "succeeded" : "failed";
      const admission =
        exitCode === 0 ? { ok: true, enqueued: true, runId: "run-1" } : { ok: true, ran: false };
      const rpcSource = `
      const summary = "x".repeat(${summaryBytes} - ${sentinel.length}) + ${JSON.stringify(sentinel)};
      const row = { ts: 1700000001000, jobId: "job-1", runId: "run-1", action: "finished",
        status: ${JSON.stringify(status)}, completionStatus: ${JSON.stringify(completionStatus)},
        summary, runAtMs: 1700000000000, durationMs: 1000 };
      export async function callGatewayFromCliRuntime(method) {
        if (method === "cron.run") return ${JSON.stringify(kind === "wait" ? { ok: true, enqueued: true, runId: "run-1" } : admission)};
        if (method === "cron.runs") return { entries: [row], total: 1, offset: 0, limit: ${kind === "wait" ? 1 : 50}, hasMore: false, nextOffset: null };
        if (method === "cron.get" && ${kind === "error"}) {
          throw Object.assign(new Error("cron job not found: missing-job"), {
            name: "GatewayClientRequestError", gatewayCode: "INVALID_REQUEST",
          });
        }
        if (method === "cron.list" && ${kind === "error"}) return {
          jobs: [], snapshotRevision: "empty-1", total: 0, offset: 0, limit: 200,
          hasMore: false, nextOffset: null,
        };
        throw new Error("unexpected Gateway RPC: " + method);
      }
    `;
      // Real Commander actions, runtime, and finalizer write to an ordinary OS pipe.
      // Only Gateway RPC results are synthetic; no live job or operator store is touched.
      const script = `
      import { registerHooks } from "node:module";
      import { Command } from "commander";
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier.endsWith("/gateway-rpc.runtime.js")) return {
            shortCircuit: true,
            url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(rpcSource)}),
          };
          return nextResolve(specifier, context);
        },
      });
      const { registerCronCli } = await import(${JSON.stringify(sourceUrl("./cron-cli.ts"))});
      const { runCliWithExitFinalization } = await import(${JSON.stringify(sourceUrl("./one-shot-exit.ts"))});
      const { applyResolvedCommandOutputMode } = await import(${JSON.stringify(sourceUrl("./json-output-mode.ts"))});
      const { isCommandJsonOutputMode } = await import(${JSON.stringify(sourceUrl("./program/json-mode.ts"))});
      process.argv = [process.execPath, "openclaw", "cron", ...${JSON.stringify(args)}];
      await runCliWithExitFinalization({
        run: async () => {
          const program = new Command().name("openclaw");
          registerCronCli(program);
          program.hook("preAction", (_parent, command) => {
            const jsonMode = isCommandJsonOutputMode(command, process.argv);
            if (jsonMode !== ${kind !== "error"}) throw new Error("incorrect command output mode");
            applyResolvedCommandOutputMode(jsonMode);
          });
          await program.parseAsync(process.argv);
        },
        onError: error => { throw error; },
      });
    `;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        TMPDIR: root,
        TSX_DISABLE_CACHE: "1",
        NODE_DISABLE_COMPILE_CACHE: "1",
        NO_COLOR: "1",
      };
      delete env.VITEST;
      delete env.VITEST_POOL_ID;
      delete env.VITEST_WORKER_ID;
      const result = spawnNodeEvalSync(script, {
        imports: ["tsx"],
        env,
        maxBuffer: 2 * summaryBytes,
        timeout: 30_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(exitCode);
      if (kind === "error") {
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
          "Automation not found: missing-job. Run `openclaw cron list` to see recent automation ids.",
        );
        return;
      }
      expect(result.stderr).toBe("");
      const value = JSON.parse(result.stdout);
      if (kind === "admission") {
        expect(value).toEqual(admission);
        return;
      }
      expect(kind === "wait" ? value.run : value.entries[0]).toMatchObject({
        jobId: "job-1",
        runId: "run-1",
        status,
        completionStatus,
        summary,
      });
      if (kind === "wait") {
        expect(value).toMatchObject({ completed: true, status, completionStatus });
      }
    },
    30_000,
  );
});
