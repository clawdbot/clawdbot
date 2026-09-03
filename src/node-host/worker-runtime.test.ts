import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { validateNodeHostStatsPayload } from "../../packages/gateway-protocol/src/index.js";
import { NODE_HOST_STATS_EVENT, NODE_HOST_STATS_INTERVAL_MS } from "../shared/node-host-stats.js";

const fixture = vi.hoisted(() => ({
  prepare: vi.fn(),
  start: vi.fn(),
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
import { runNodeHostWorker } from "./worker.js";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function startWorkerFixture(workerHostingEnabled = true, workerHostingDisabledReason?: string) {
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
            ok: true,
            result: {},
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
  fixture.prepare.mockResolvedValue({
    manifest: { commands: ["system.run"], caps: ["system"], pathEnv: "/bin" },
    workerHostingEnabled,
    workerHostingDisabledReason,
    initialInventory: { skills: [], pluginTools: [] },
    start: fixture.start,
  });
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
        expect(fixture.runtime.close).toHaveBeenCalledOnce();
        expect(fixture.runtime.updateGatewayConnection).toHaveBeenLastCalledWith();
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
