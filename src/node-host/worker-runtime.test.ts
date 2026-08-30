import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";

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

afterEach(() => {
  vi.restoreAllMocks();
});

it("publishes hosting through the app route and retires it on disconnect", async () => {
  const events = new EventEmitter();
  const input = Object.assign(events, {
    close: () => {
      events.emit("close");
    },
  });
  fixture.input = input;
  const messages: Array<Record<string, unknown>> = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
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
    callbacks.onRunnerCapacityChanged?.({ total: 2, available: 2 });
    return fixture.runtime;
  });
  fixture.prepare.mockResolvedValue({
    manifest: { commands: ["system.run"], caps: ["system"], pathEnv: "/bin" },
    workerHostingEnabled: true,
    initialInventory: { skills: [], pluginTools: [] },
    start: fixture.start,
  });
  const running = runNodeHostWorker();
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
  } finally {
    input.close();
    await running;
  }
});
