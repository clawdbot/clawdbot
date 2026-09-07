import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { isPidAlive } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { CodexAppServerClient } from "./client.js";
import { isJsonObject } from "./protocol.js";
import {
  createNativeRunParams as createParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import {
  resetSharedCodexAppServerClientForTests,
  retainSharedCodexAppServerClientIfCurrent,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { createClientHarness, waitForHarnessRequest } from "./test-support.js";
import * as processSnapshot from "./transport-process-snapshot.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

async function stopTaskOwnedProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
  await expect.poll(() => isPidAlive(pid), { timeout: 2_000 }).toBe(false);
}

function runOneShot(client: CodexAppServerClient, abortSignal?: AbortSignal) {
  vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(client);
  const params = createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace"));
  params.oneShotCliRun = true;
  params.cleanupBundleMcpOnRunEnd = true;
  if (abortSignal) {
    params.abortSignal = abortSignal;
  }
  return runCodexAppServerAttempt(params, { bindingStore: testCodexAppServerBindingStore });
}

setupRunAttemptTestHooks();

describe("Codex one-shot cleanup receipts", () => {
  beforeEach(() => {
    resetSharedCodexAppServerClientForTests();
  });

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
  });

  it.each(["completed", "cancelled"] as const)(
    "preserves a %s one-shot outcome while native terminal cleanup remains uncertain",
    async (completion) => {
      let terminalTerminated = false;
      const results: Record<string, unknown> = {
        initialize: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
        "thread/start": threadStartResult(),
        "turn/start": turnStartResult(),
      };
      const harness = createClientHarness({
        onWrite: (line, send) => {
          const request = JSON.parse(line) as { id?: number; method: string };
          if (request.id === undefined) {
            return;
          }
          let result = results[request.method] ?? {};
          if (request.method === "thread/backgroundTerminals/list") {
            result = { data: terminalTerminated ? [] : [{ processId: "10" }], nextCursor: null };
          } else if (request.method === "thread/backgroundTerminals/terminate") {
            terminalTerminated = true;
            result = { terminated: true };
          }
          send({ id: request.id, result });
          if (request.method === "turn/interrupt") {
            send({
              method: "turn/completed",
              params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } },
            });
          }
        },
      });
      const warning = vi.spyOn(embeddedAgentLog, "warn");
      const abort = new AbortController();
      const run = runOneShot(harness.client, abort.signal);
      try {
        await waitForHarnessRequest(harness, "turn/start");
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        if (completion === "cancelled") {
          abort.abort("cancelled");
          expect(readAttemptTerminal(await run)).toMatchObject({ aborted: true, timedOut: false });
        } else {
          harness.send({
            method: "turn/completed",
            params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
          });
          expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, timedOut: false });
        }
        expect(terminalTerminated).toBe(true);
        const step =
          completion === "cancelled" ? "codex-shared-client-release" : "codex-one-shot-terminals";
        expect(warning).toHaveBeenCalledWith(expect.stringContaining(`step=${step} error=Codex`));
      } finally {
        harness.client.close();
        await run.catch(() => undefined);
      }
    },
  );

  it.each(["active lease", "missing entry"] as const)(
    "records uncertain one-shot cleanup when shared retirement is refused: %s",
    async (reason) => {
      const harness = createClientHarness();
      const warning = vi.spyOn(embeddedAgentLog, "warn");
      let releasePeer: (() => void) | undefined;
      const run = runOneShot(harness.client);
      try {
        const initialize = await waitForHarnessRequest(harness, "initialize");
        harness.send({
          id: initialize.id,
          result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
        });
        const thread = await waitForHarnessRequest(harness, "thread/start");
        harness.send({ id: thread.id, result: threadStartResult() });
        const turn = await waitForHarnessRequest(harness, "turn/start");
        harness.send({ id: turn.id, result: turnStartResult() });
        releasePeer = retainSharedCodexAppServerClientIfCurrent(harness.client);
        if (reason === "missing entry") {
          retireSharedCodexAppServerClientIfCurrent(harness.client);
        }
        harness.send({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        });
        const terminals = await waitForHarnessRequest(harness, "thread/backgroundTerminals/list");
        harness.send({ id: terminals.id, result: { data: [], nextCursor: null } });
        const unsubscribe = await waitForHarnessRequest(harness, "thread/unsubscribe");
        harness.send({ id: unsubscribe.id, result: {} });
        expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, timedOut: false });
        expect(warning).toHaveBeenCalledWith(
          expect.stringMatching(/agent cleanup failed:.*step=codex-shared-client-release/),
        );
        const requestStart = harness.writes.length;
        const peerRead = harness.client.request("thread/read", {
          threadId: "thread-peer",
          includeTurns: false,
        });
        const read = await waitForHarnessRequest(harness, "thread/read", requestStart);
        const result = threadStartResult("thread-peer");
        harness.send({ id: read.id, result });
        await expect(peerRead).resolves.toEqual(result);
      } finally {
        releasePeer?.();
        harness.client.close();
        await run.catch(() => undefined);
      }
    },
  );

  it
    .skipIf(process.platform === "win32")
    .each(["confirmed", "unknown", "forced", "signalled", "retired-command"])(
    "records one-shot cleanup accurately after %s app-server shutdown",
    async (shutdown) => {
      const rootPath = path.join(tempDir, "cleanup-root.mjs");
      const descendantPath = path.join(tempDir, "cleanup-descendant.mjs");
      const descendantPidPath = path.join(tempDir, "cleanup-descendant.pid");
      await fs.writeFile(descendantPath, "setInterval(() => {}, 1_000);\n");
      const launcherPath = path.join(tempDir, "cleanup-launcher.mjs");
      await fs.writeFile(
        launcherPath,
        `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, [process.argv[2]], { detached: true, stdio: "ignore" });
child.unref();
writeFileSync(process.argv[3], String(child.pid));
`,
      );
      await fs.writeFile(
        rootPath,
        `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [descendantPath, descendantPidPath] = process.argv.slice(2);
const descendant = spawn(process.execPath, ${shutdown === "retired-command" ? `[${JSON.stringify(launcherPath)}, descendantPath, descendantPidPath]` : "[descendantPath]"}, { detached: true, stdio: "ignore" });
${shutdown === "retired-command" ? 'await new Promise(resolve => descendant.once("exit", resolve));' : "writeFileSync(descendantPidPath, String(descendant.pid));"}
descendant.unref();
const results = ${JSON.stringify({
          initialize: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
          "config/read": { config: {}, origins: {}, layers: [] },
          "configRequirements/read": { requirements: null },
          "thread/start": threadStartResult(),
          "turn/start": turnStartResult(),
          "thread/backgroundTerminals/list": { data: [], nextCursor: null },
        })};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "test/complete") {
    ${shutdown === "retired-command" ? 'send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: "retired-command", command: "fixture", cwd: process.cwd(), status: "completed", exitCode: 0, aggregatedOutput: "" } } });' : ""}
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  } else if (request.id !== undefined) {
    send({ id: request.id, result: results[request.method] ?? {} });
    if (request.method === "turn/start") {
      send({ method: "turn/started", params: { threadId: "thread-1", turn: results["turn/start"].turn } });
    }
  }
});
process.stdin.on("end", () => ${
          shutdown === "forced"
            ? "setInterval(() => {}, 1_000)"
            : shutdown === "signalled"
              ? 'process.kill(process.pid, "SIGKILL")'
              : "process.exit(0)"
        });
`,
      );
      const child = spawn(process.execPath, [rootPath, descendantPath, descendantPidPath], {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const exited = once(child, "exit");
      const client = CodexAppServerClient.fromTransportForTests(child);
      if (shutdown === "unknown") {
        vi.spyOn(processSnapshot, "readCodexAppServerProcessSnapshot").mockRejectedValue(
          new processSnapshot.ProcessInspectionError("unavailable"),
        );
      }
      const turnStarted = createDeferred<void>();
      const removeTurnStartedHandler = client.addNotificationHandler((notification) => {
        if (
          notification.method === "turn/started" &&
          isJsonObject(notification.params) &&
          notification.params.threadId === "thread-1" &&
          isJsonObject(notification.params.turn) &&
          notification.params.turn.id === "turn-1" &&
          notification.params.turn.status === "inProgress"
        ) {
          turnStarted.resolve();
        }
      });
      const warning = vi.spyOn(embeddedAgentLog, "warn");
      const run = runOneShot(client);
      try {
        await Promise.race([
          turnStarted.promise,
          run.then(() => {
            throw new Error("Codex attempt settled before the fixture emitted turn/started");
          }),
        ]);
        client.notify("test/complete");
        expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, timedOut: false });
        await exited;
        const descendantPid = Number(await fs.readFile(descendantPidPath, "utf8"));
        const signalled = shutdown === "forced" || shutdown === "signalled";
        expect(child.exitCode).toBe(signalled ? null : 0);
        expect(child.signalCode).toBe(signalled ? "SIGKILL" : null);
        await expect
          .poll(() => isPidAlive(descendantPid), { timeout: 2_000 })
          .toBe(shutdown === "unknown" || shutdown === "retired-command");
        // This is the cleanup guard that also records the one-shot recovery
        // receipt; a clean root exit must not bypass its failure path.
        if (shutdown === "confirmed") {
          expect(warning).not.toHaveBeenCalled();
        } else {
          expect(warning).toHaveBeenCalledWith(
            expect.stringMatching(/agent cleanup failed:.*step=codex-shared-client-release/),
          );
        }
      } finally {
        removeTurnStartedHandler();
        client.close();
        child.kill("SIGKILL");
        await exited;
        await run.catch(() => undefined);
        const descendantPid = Number(await fs.readFile(descendantPidPath, "utf8").catch(() => ""));
        if (descendantPid) {
          await stopTaskOwnedProcess(descendantPid);
        }
      }
    },
  );
});
