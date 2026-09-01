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
  requestExit: vi.fn(),
}));
vi.mock("node:readline", () => ({ createInterface: () => fixture.input }));
vi.mock("../cli/one-shot-exit.js", () => ({ requestExitAfterOneShotOutput: fixture.requestExit }));
vi.mock("./startup-state-migrations.js", () => ({ runStartupMigrations: async () => {} }));
vi.mock("./config.js", () => ({ loadNodeHostConfig: async () => ({}) }));
vi.mock("./runtime.js", () => ({ prepareNodeHostRuntime: fixture.prepare }));
import { runNodeHostWorker } from "./worker.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("requests the CLI exit once the worker has stopped instead of waiting for a drain", async () => {
  const events = new EventEmitter();
  const input = Object.assign(events, {
    close: () => {
      events.emit("close");
    },
  });
  fixture.input = input;
  const messages: Array<Record<string, unknown>> = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    messages.push(JSON.parse(String(chunk)));
    return true;
  });
  fixture.start.mockReturnValue(fixture.runtime);
  fixture.prepare.mockResolvedValue({
    manifest: { commands: ["system.run"], caps: ["system"], pathEnv: "/bin" },
    workerHostingEnabled: true,
    initialInventory: { skills: [], pluginTools: [] },
    start: fixture.start,
  });
  let settleClose: (() => void) | undefined;
  fixture.runtime.close.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      settleClose = resolve;
    }),
  );
  const previousExitCode = process.exitCode;
  const running = runNodeHostWorker();
  try {
    await vi.waitFor(() => expect(messages.some((message) => message.type === "ready")).toBe(true));
    expect(fixture.requestExit).not.toHaveBeenCalled();
    input.emit("line", JSON.stringify({ type: "stop" }));
    await setImmediate();
    // Owners still closing must finish before the exit is requested.
    expect(fixture.runtime.close).toHaveBeenCalledOnce();
    expect(fixture.requestExit).not.toHaveBeenCalled();
    settleClose?.();
    await running;
  } finally {
    process.exitCode = previousExitCode;
  }
  // A plugin-owned child can keep ref'd pipes past runtime.close(); the worker
  // must not depend on the event loop draining to exit.
  expect(fixture.requestExit).toHaveBeenCalledOnce();
});
