// Signal link RPC tests cover child-owned JSON-line request routing.
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalJsonRpcProcess } from "./daemon.js";
import { createSignalLinkRpcClient } from "./link-rpc.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("./daemon.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./daemon.js")>()),
  spawnSignalJsonRpcProcess: mocks.spawn,
}));

function createProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  type ExitEvent = Awaited<SignalJsonRpcProcess["exited"]>;
  let resolveExit!: (exit: ExitEvent) => void;
  const exited = new Promise<ExitEvent>((resolve) => {
    resolveExit = resolve;
  });
  const process: SignalJsonRpcProcess = {
    stdin,
    stdout,
    exited,
    isExited: () => false,
    stop: vi.fn(async () => {}),
  };
  return { process, resolveExit };
}

let fixture: ReturnType<typeof createProcess>;

beforeEach(() => {
  fixture = createProcess();
  mocks.spawn.mockReset().mockReturnValue(fixture.process);
});

afterEach(() => {
  (fixture.process.stdin as PassThrough).end();
  (fixture.process.stdout as PassThrough).end();
});

describe("SignalLinkRpcClient", () => {
  it("routes a response through the owned child pipes", async () => {
    const client = createSignalLinkRpcClient({
      cliPath: "signal-cli",
      configPath: "/tmp/signal",
    });
    const written = once(fixture.process.stdin, "data");
    const response = client.request("startLink", undefined, { maxResponseBytes: 1024 });
    const [chunk] = await written;
    const request = JSON.parse(String(chunk)) as { id: string; method: string };

    expect(request.method).toBe("startLink");
    fixture.process.stdout.emit(
      "data",
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { deviceLinkUri: "sgnl://linkdevice?uuid=test" } })}\n`,
    );

    await expect(response).resolves.toEqual({
      deviceLinkUri: "sgnl://linkdevice?uuid=test",
    });
    expect(mocks.spawn).toHaveBeenCalledWith({
      cliPath: "signal-cli",
      configPath: "/tmp/signal",
    });
    await client.stop();
    expect(fixture.process.stop).toHaveBeenCalledOnce();
  });

  it("rejects a pending request when the owned child exits", async () => {
    const client = createSignalLinkRpcClient({ cliPath: "signal-cli" });
    const response = client.request("listAccounts");

    fixture.resolveExit({ source: "process", code: 1, signal: null });

    await expect(response).rejects.toThrow("signal daemon exited");
  });

  it("rejects a pending request when the child closes stdin", async () => {
    const client = createSignalLinkRpcClient({ cliPath: "signal-cli" });
    const response = client.request("listAccounts");

    fixture.process.stdin.emit("error", new Error("write EPIPE"));

    await expect(response).rejects.toThrow("write EPIPE");
  });

  it("rejects an oversized response before parsing it", async () => {
    const client = createSignalLinkRpcClient({ cliPath: "signal-cli" });
    const written = once(fixture.process.stdin, "data");
    const response = client.request("listAccounts", undefined, { maxResponseBytes: 64 });
    const [chunk] = await written;
    const request = JSON.parse(String(chunk)) as { id: string };

    fixture.process.stdout.emit(
      "data",
      `${JSON.stringify({ id: request.id, result: "x".repeat(128) })}\n`,
    );

    await expect(response).rejects.toThrow("response exceeded size limit");
  });

  it("bounds fragmented unterminated output before line framing", async () => {
    const client = createSignalLinkRpcClient({ cliPath: "signal-cli" });
    const response = client.request("listAccounts", undefined, { maxResponseBytes: 64 });

    fixture.process.stdout.emit("data", "x".repeat(40));
    fixture.process.stdout.emit("data", "x".repeat(25));

    await expect(response).rejects.toThrow("response exceeded size limit");
    expect(fixture.process.stop).toHaveBeenCalledOnce();
  });
});
