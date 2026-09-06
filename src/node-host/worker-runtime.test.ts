import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { validateNodeHostStatsPayload } from "../../packages/gateway-protocol/src/index.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { testing as execApprovalsStoreTesting } from "../infra/exec-approvals-store.test-support.js";
import { saveExecApprovals } from "../infra/exec-approvals.js";
import { clearExecutablePathCache } from "../infra/executable-path.js";
import { NODE_HOST_STATS_EVENT, NODE_HOST_STATS_INTERVAL_MS } from "../shared/node-host-stats.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { ExecEventPayload } from "./invoke-types.js";

const fixture = vi.hoisted(() => ({
  prepare: vi.fn(),
  start: vi.fn(),
  handleInvoke: vi.fn<typeof import("./invoke.js").handleInvoke>(),
  input: undefined as EventEmitter | undefined,
  runtime: {
    invoke: vi.fn(),
    handleInput: vi.fn(),
    cancel: vi.fn(),
    cancelAll: vi.fn(),
    updateGatewayConnection: vi.fn(),
    close: vi.fn(),
  },
}));
vi.mock("node:readline", () => ({ createInterface: () => fixture.input }));
vi.mock("./startup-state-migrations.js", () => ({ runStartupMigrations: async () => {} }));
vi.mock("./config.js", () => ({ loadNodeHostConfig: async () => ({}) }));
vi.mock("./runtime.js", () => ({ prepareNodeHostRuntime: fixture.prepare }));
vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: vi.fn() }));
vi.mock("../infra/terminal-file-upload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/terminal-file-upload.js")>()),
  ensureTerminalUploadCleanup: async () => {},
}));
vi.mock("./invoke.js", () => ({ handleInvoke: fixture.handleInvoke }));
vi.mock("./mcp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp.js")>()),
  startNodeHostMcpManager: async () => ({ descriptors: [], close: async () => {} }),
}));
vi.mock("./plugin-node-host.js", () => ({
  ensureNodeHostPluginRegistry: async () => {},
  invokeRegisteredNodeHostCommand: async () => null,
  isRegisteredNodeHostCommandDuplex: () => false,
  listRegisteredNodeHostCapsAndCommands: () => ({ caps: [], commands: [], nodePluginTools: [] }),
  notifyRegisteredNodeHostCommandDisconnect: async () => {},
  watchRegisteredNodeHostCommandAvailability: () => () => {},
}));
import { runNodeHostWorker } from "./worker.js";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type PreparedRuntime = Awaited<ReturnType<typeof import("./runtime.js").prepareNodeHostRuntime>>;

function startWorkerFixture(
  workerHostingEnabled = true,
  workerHostingDisabledReason?: string,
  options: {
    prepared?: PreparedRuntime;
    gatewayResponse?: (
      message: Record<string, unknown>,
    ) => { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
  } = {},
) {
  const events = new EventEmitter();
  const input = Object.assign(events, {
    close: () => {
      events.emit("close");
    },
  });
  fixture.input = input;
  const messages: Array<Record<string, unknown>> = [];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    const message = JSON.parse(String(chunk));
    messages.push(message);
    if (message.type === "gateway-request") {
      queueMicrotask(() =>
        input.emit(
          "line",
          JSON.stringify({
            type: "gateway-response",
            generation: message.generation,
            id: message.id,
            ...(options.gatewayResponse?.(message) ?? { ok: true, result: {} }),
          }),
        ),
      );
    }
    return true;
  });
  fixture.start.mockImplementation((callbacks) => {
    if (workerHostingEnabled) {
      callbacks.onRunnerCapacityChanged?.({ total: 2, available: 2 });
    }
    return fixture.runtime;
  });
  fixture.prepare.mockResolvedValue(
    options.prepared ?? {
      manifest: { commands: ["system.run"], caps: ["system"], pathEnv: "/bin" },
      workerHostingEnabled,
      workerHostingDisabledReason,
      initialInventory: { skills: [], pluginTools: [] },
      start: fixture.start,
    },
  );
  const previousExitCode = process.exitCode;
  const interruptListeners = process.listeners("SIGINT");
  const terminateListeners = process.listeners("SIGTERM");
  const running = runNodeHostWorker();
  return {
    input,
    messages,
    stderr,
    stdout,
    stop: async () => {
      try {
        input.close();
        await running;
        if (!options.prepared) {
          expect(fixture.runtime.close).toHaveBeenCalledOnce();
          expect(fixture.runtime.updateGatewayConnection).toHaveBeenLastCalledWith();
        }
        expect(process.listeners("SIGINT")).toEqual(interruptListeners);
        expect(process.listeners("SIGTERM")).toEqual(terminateListeners);
      } finally {
        process.exitCode = previousExitCode;
      }
    },
  };
}

it("publishes hosting through the app route and retires it on disconnect", async () => {
  const { input, messages, stderr, stop } = startWorkerFixture();
  try {
    await vi.waitFor(() => expect(messages.some((message) => message.type === "ready")).toBe(true));
    expect(fixture.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ enableWorkerRuns: true }),
    );
    const connection = {
      url: "wss://gateway.example.test/current",
      protocol: 4,
      capabilities: ["node.worker.bundleRetention.v1"],
    };
    input.emit("line", JSON.stringify({ type: "gateway-connection", generation: 1, connection }));
    await vi.waitFor(() =>
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: "gateway-request",
          method: "node.runnerInventory.update",
          params: expect.objectContaining({
            workerHost: expect.objectContaining({ enabled: true }),
          }),
        }),
      ),
    );
    expect(fixture.runtime.updateGatewayConnection).toHaveBeenCalledWith(
      expect.objectContaining({ url: connection.url }),
    );
    input.emit(
      "line",
      JSON.stringify({ type: "gateway-connection", generation: 2, connection: null }),
    );
    expect(fixture.runtime.cancelAll).toHaveBeenCalled();
    expect(fixture.runtime.updateGatewayConnection).toHaveBeenLastCalledWith();
    input.emit("line", JSON.stringify({ type: "gateway-connection", generation: 3, connection }));
    await setImmediate();
    const callbacks = fixture.start.mock.calls[0]?.[0];
    if (!callbacks) {
      throw new Error("runtime was not started");
    }
    const count = messages.length;
    // Capacity is owned by the supervisor; cleanup from an old invocation can
    // notify it after reconnect without acquiring that invocation's authority.
    callbacks.client.withConnection(1, () =>
      callbacks.onRunnerCapacityChanged({ total: 2, available: 1 }),
    );
    await vi.waitFor(() =>
      expect(messages.slice(count)).toContainEqual(
        expect.objectContaining({
          type: "gateway-request",
          generation: 3,
          method: "node.runnerInventory.update",
          params: expect.objectContaining({
            workerHost: expect.objectContaining({
              capacity: { total: 2, available: 1 },
            }),
          }),
        }),
      ),
    );
    callbacks.onManifestChanged({ commands: ["system.run"], caps: ["system"], pathEnv: "/bin" });
    input.emit(
      "line",
      JSON.stringify({
        type: "invoke",
        generation: 3,
        request: { id: "stale", nodeId: "node", command: "system.worker.start" },
      }),
    );
    expect(fixture.runtime.invoke).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  } finally {
    await stop();
  }
});

it.runIf(process.platform !== "win32").each([
  { scenario: "same Gateway reconnect", target: "a", elapsedMs: 0, rejectRefresh: false },
  { scenario: "replacement within cache TTL", target: "b", elapsedMs: 0, rejectRefresh: false },
  { scenario: "replacement after cache TTL", target: "b", elapsedMs: 90_001, rejectRefresh: false },
  { scenario: "replacement refresh failure", target: "b", elapsedMs: 90_001, rejectRefresh: true },
])("scopes skill-authorized execution to the worker connection: $scenario", async (scenario) => {
  await withTestDir({ prefix: "openclaw-skill-exec-" }, async (dir) => {
    await withEnvAsync(
      {
        OPENCLAW_HOME: dir,
        OPENCLAW_STATE_DIR: path.join(dir, "state"),
        OPENCLAW_NODE_EXEC_HOST: undefined,
        OPENCLAW_NODE_EXEC_FALLBACK: "0",
        PATH: "/usr/bin:/bin",
      },
      async () => {
        closeOpenClawStateDatabaseForTest();
        execApprovalsStoreTesting.reset();
        const now = Date.now;
        let elapsedMs = 0;
        vi.spyOn(Date, "now").mockImplementation(() => now() + elapsedMs);
        let stop: (() => Promise<void>) | undefined;
        try {
          fs.accessSync(fs.realpathSync("/usr/bin/true"), fs.constants.X_OK);
          setRuntimeConfigSnapshot({ tools: { exec: { mode: "allowlist" } } });
          saveExecApprovals({
            version: 1,
            defaults: {
              security: "allowlist",
              ask: "off",
              askFallback: "deny",
              autoAllowSkills: true,
            },
            agents: {},
          });
          // Exec-host selection is captured on import. This lane exercises real
          // Node policy/commit/spawn; native app execution has its own proof.
          const { handleInvoke } =
            await vi.importActual<typeof import("./invoke.js")>("./invoke.js");
          fixture.handleInvoke.mockImplementation(handleInvoke);
          const { prepareNodeHostRuntime } =
            await vi.importActual<typeof import("./runtime.js")>("./runtime.js");
          const prepared = await prepareNodeHostRuntime({
            config: { nodeHost: { skills: { enabled: false } } },
            enableDuplexPluginCommands: true,
            enableWorkerRuns: true,
          });
          let rejectSameGatewayRefresh = false;
          const worker = startWorkerFixture(false, undefined, {
            prepared,
            gatewayResponse: (message) => {
              if (message.method !== "skills.bins") {
                return { ok: true, result: {} };
              }
              if (message.generation === 1 || scenario.target === "a") {
                return rejectSameGatewayRefresh
                  ? {
                      ok: false,
                      error: { code: "UNAVAILABLE", message: "same Gateway unavailable" },
                    }
                  : { ok: true, result: { bins: ["true"] } };
              }
              return scenario.rejectRefresh
                ? { ok: false, error: { code: "UNAVAILABLE", message: "replacement unavailable" } }
                : { ok: true, result: { bins: [] } };
            },
          });
          stop = worker.stop;
          const { input, messages } = worker;
          const connect = (generation: number, target: string) => {
            input.emit(
              "line",
              JSON.stringify({
                type: "gateway-connection",
                generation,
                connection: {
                  url: `wss://gateway-${target}.example.test`,
                  protocol: 4,
                  capabilities: [],
                },
              }),
            );
          };
          const invoke = async (generation: number, id: string) => {
            input.emit(
              "line",
              JSON.stringify({
                type: "invoke",
                generation,
                request: {
                  id,
                  nodeId: "node",
                  command: "system.run",
                  paramsJSON: JSON.stringify({
                    // A shell-wrapped `true` has independent builtin trust.
                    // Bare argv requires the actual skill entry in this lane.
                    command: ["true"],
                    cwd: dir,
                    agentId: "main",
                    sessionKey: "agent:main:skill-trust-proof",
                    runId: id,
                    timeoutMs: 2_000,
                  }),
                },
              }),
            );
            const message = await vi.waitFor(
              () => {
                const result = messages.find(
                  (entry) =>
                    entry.type === "invoke-result" &&
                    (entry.result as { id?: string } | undefined)?.id === id,
                );
                if (!result) {
                  throw new Error(`missing worker invocation result: ${id}`);
                }
                return result;
              },
              { timeout: 5_000 },
            );
            expect(message).toMatchObject({ generation, result: { id } });
            return message.result as {
              ok: boolean;
              payloadJSON?: string;
              error?: { code: string; message: string };
            };
          };
          const eventsFor = (id: string) =>
            messages
              .filter((message) => message.type === "node-event")
              .map((message) => {
                const event = message.event as { event: string; payloadJSON: string };
                return {
                  generation: message.generation,
                  event: event.event,
                  payload: JSON.parse(event.payloadJSON) as ExecEventPayload,
                };
              })
              .filter((event) => event.payload.runId === id);
          const expectExecuted = (
            result: Awaited<ReturnType<typeof invoke>>,
            generation: number,
            id: string,
          ) => {
            expect(result).toMatchObject({ ok: true });
            expect(JSON.parse(result.payloadJSON ?? "null")).toEqual({
              exitCode: 0,
              timedOut: false,
              success: true,
              stdout: "",
              stderr: "",
              error: null,
            });
            expect(eventsFor(id)).toEqual([
              {
                generation,
                event: "exec.finished",
                payload: expect.objectContaining({
                  runId: id,
                  host: "node",
                  success: true,
                  exitCode: 0,
                }),
              },
            ]);
          };
          const skillRequests = () =>
            messages.filter((message) => message.method === "skills.bins");
          await vi.waitFor(() =>
            expect(messages.some((message) => message.type === "ready")).toBe(true),
          );
          connect(1, "a");
          for (const id of ["a-warm", "a-cached-control"]) {
            expectExecuted(await invoke(1, id), 1, id);
          }
          expect(skillRequests()).toHaveLength(1);
          input.emit(
            "line",
            JSON.stringify({ type: "gateway-connection", generation: 2, connection: null }),
          );
          // Advance expiry only after both real processes have completed.
          elapsedMs = scenario.elapsedMs;
          connect(3, scenario.target);
          const replacement = await invoke(3, "new-invoke");
          if (scenario.target === "a") {
            expectExecuted(replacement, 3, "new-invoke");
            const requestsAfterReconnect = skillRequests().length;
            expectExecuted(await invoke(3, "a-reconnected-cached"), 3, "a-reconnected-cached");
            expect(skillRequests()).toHaveLength(requestsAfterReconnect);
            elapsedMs = 90_001;
            rejectSameGatewayRefresh = true;
            expectExecuted(await invoke(3, "a-refresh-failed"), 3, "a-refresh-failed");
            expect(skillRequests()).toHaveLength(requestsAfterReconnect + 1);
            expect(skillRequests().at(-1)).toMatchObject({ generation: 3 });
          } else {
            expect(replacement).toMatchObject({
              ok: false,
              error: { code: "SYSTEM_RUN_DENIED", message: "SYSTEM_RUN_DENIED: allowlist miss" },
            });
            expect(eventsFor("new-invoke")).toEqual([
              {
                generation: 3,
                event: "exec.denied",
                payload: expect.objectContaining({
                  runId: "new-invoke",
                  host: "node",
                  reason: "allowlist-miss",
                }),
              },
            ]);
            expect(skillRequests().at(-1)).toMatchObject({ generation: 3 });
          }
          expect(messages.filter((message) => message.type === "ready")).toHaveLength(1);
        } finally {
          try {
            await stop?.();
          } finally {
            fixture.handleInvoke.mockReset();
            execApprovalsStoreTesting.reset();
            closeOpenClawStateDatabaseForTest();
            clearRuntimeConfigSnapshot();
            clearExecutablePathCache();
          }
        }
      },
    );
  });
});

it("publishes host stats through the native bridge only while connected", async () => {
  const { input, messages, stop } = startWorkerFixture(false);
  const publications = () => messages.filter((message) => message.type === "node-event");
  try {
    await vi.waitFor(() => expect(messages.some((message) => message.type === "ready")).toBe(true));
    expect(publications()).toEqual([]);
    vi.useFakeTimers();
    input.emit(
      "line",
      JSON.stringify({
        type: "gateway-connection",
        generation: 1,
        connection: { url: "wss://gateway.example.test", protocol: 4, capabilities: [] },
      }),
    );
    expect(publications()).toHaveLength(1);
    expect(publications()[0]).toMatchObject({
      type: "node-event",
      generation: 1,
      event: { event: NODE_HOST_STATS_EVENT },
    });
    const params = publications()[0]?.event as { payloadJSON: string };
    expect(validateNodeHostStatsPayload(JSON.parse(params.payloadJSON))).toBe(true);
    await vi.advanceTimersByTimeAsync(NODE_HOST_STATS_INTERVAL_MS);
    expect(publications()).toHaveLength(2);
    input.emit(
      "line",
      JSON.stringify({ type: "gateway-connection", generation: 2, connection: null }),
    );
    await vi.advanceTimersByTimeAsync(NODE_HOST_STATS_INTERVAL_MS);
    expect(publications()).toHaveLength(2);
  } finally {
    await stop();
    vi.useRealTimers();
  }
});

it.each(["prepared failure", "later failure", "configured opt-out"] as const)(
  "keeps worker hosting diagnostics local across reconnects: %s",
  async (scenario) => {
    const secret = "fixture-secret";
    const action = "install and start the engine";
    const reason = `Docker authentication failed (password=${secret}); ${action}`;
    const preparedFailure = scenario === "prepared failure";
    const laterFailure = scenario === "later failure";
    const { input, messages, stderr, stdout, stop } = startWorkerFixture(
      laterFailure,
      preparedFailure ? reason : undefined,
    );
    const expectDiagnostic = () => {
      expect(stderr).toHaveBeenCalledOnce();
      const diagnostic = String(stderr.mock.calls[0]?.[0]);
      expect(diagnostic).toContain(
        "node host worker hosting disabled: Docker authentication failed",
      );
      expect(diagnostic).toContain(action);
      expect(diagnostic).not.toContain(secret);
    };
    try {
      await vi.waitFor(() =>
        expect(messages.some((message) => message.type === "ready")).toBe(true),
      );
      expect(messages).toHaveLength(1);
      if (preparedFailure) {
        expectDiagnostic();
        expect(stderr.mock.invocationCallOrder[0]).toBeLessThan(
          stdout.mock.invocationCallOrder[0]!,
        );
      } else {
        expect(stderr).not.toHaveBeenCalled();
      }
      const connection = {
        url: "wss://gateway.example.test/current",
        protocol: 4,
        capabilities: [],
      };
      const inventories = () =>
        messages.filter((message) => message.method === "node.runnerInventory.update");
      input.emit("line", JSON.stringify({ type: "gateway-connection", generation: 1, connection }));
      await setImmediate();
      if (laterFailure) {
        expect(inventories()).toHaveLength(1);
        expect(inventories()[0]?.params).toMatchObject({ workerHost: { enabled: true } });
        fixture.start.mock.calls[0]?.[0].onWorkerHostingDisabled(reason);
        await setImmediate();
        expectDiagnostic();
      }
      const disabledInventory = expect.objectContaining({ workerHost: { enabled: false } });
      expect(inventories()).toHaveLength(laterFailure ? 2 : 1);
      expect(inventories().at(-1)?.params).toEqual(disabledInventory);
      input.emit(
        "line",
        JSON.stringify({ type: "gateway-connection", generation: 2, connection: null }),
      );
      input.emit("line", JSON.stringify({ type: "gateway-connection", generation: 3, connection }));
      await setImmediate();
      expect(inventories()).toHaveLength(laterFailure ? 3 : 2);
      expect(inventories().at(-1)).toMatchObject({ generation: 3, params: disabledInventory });
      if (scenario === "configured opt-out") {
        expect(stderr).not.toHaveBeenCalled();
      } else {
        expectDiagnostic();
      }
      const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(output).not.toContain(secret);
      expect(output).not.toContain(reason);
      expect(output).not.toContain(action);
      expect(output).not.toContain("worker hosting disabled");
      expect(messages.filter((message) => message.type === "ready")).toHaveLength(1);
      expect(messages.some((message) => message.type === "manifest")).toBe(false);
    } finally {
      await stop();
    }
  },
);
