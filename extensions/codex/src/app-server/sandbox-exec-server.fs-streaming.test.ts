// Covers bounded Codex sandbox file streams, handles, and cancellation.
import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import { ensureCodexSandboxExecServerEnvironment } from "./sandbox-exec-server.js";
import {
  codexFsSandboxContext,
  createClient,
  createSandboxContext,
  execServerUrlFromClient,
  globPath,
  openSocket,
  rpc,
  specialPath,
  waitForSocketClose,
} from "./sandbox-exec-server.test-helpers.js";

afterEach(async () => {
  vi.unstubAllEnvs();
  await sandboxExecServerRegistry.closeAll();
});

describe("OpenClaw Codex sandbox exec-server filesystem streaming", () => {
  it("streams sandbox files through connection-owned Codex file handles", async () => {
    const data = Buffer.from("0123456789");
    const readFile = vi.fn(async () => data);
    const sandbox = createSandboxContext({
      readFile,
      stat: async () => ({ type: "file", size: data.byteLength, mtimeMs: 1 }),
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "fs/open", {
        handleId: "stream-1",
        path: "file:///workspace/attachment.txt",
      }),
    ).resolves.toEqual({ handleId: "stream-1" });

    for (const [offset, len, expected, eof] of [
      [6, 3, "678", false],
      [1, 2, "12", false],
      [8, 4, "89", true],
      [8, 2, "89", true],
      [0, 2, "01", false],
      [0, 10, "0123456789", true],
      [10, 2, "", true],
    ] as const) {
      await expect(
        rpc(socket, "fs/readBlock", { handleId: "stream-1", offset, len }),
      ).resolves.toEqual({
        chunk: Buffer.from(expected).toString("base64"),
        eof,
      });
    }

    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith({
      filePath: "/workspace/attachment.txt",
      maxBytes: data.byteLength,
      signal: expect.any(AbortSignal),
    });
    await expect(rpc(socket, "fs/close", { handleId: "stream-1" })).resolves.toEqual({});
    await expect(rpc(socket, "fs/close", { handleId: "stream-1" })).resolves.toEqual({});
    await expect(
      rpc(socket, "fs/readBlock", { handleId: "stream-1", offset: 0, len: 1 }),
    ).rejects.toMatchObject({ code: -32004 });
    socket.close();
  });

  it("isolates file handles between authenticated exec-server connections", async () => {
    const readFile = vi.fn(async ({ filePath }: { filePath: string }) =>
      Buffer.from(filePath.endsWith("first.txt") ? "first" : "second"),
    );
    const sandbox = createSandboxContext({
      readFile,
      stat: async ({ filePath }) => ({
        type: "file",
        size: filePath.endsWith("first.txt") ? 5 : 6,
        mtimeMs: 1,
      }),
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const first = await openSocket(execServerUrlFromClient(client));
    const second = await openSocket(execServerUrlFromClient(client));

    for (const socket of [first, second]) {
      await rpc(socket, "initialize", { clientName: "test" });
      socket.send(JSON.stringify({ method: "initialized" }));
    }
    await rpc(first, "fs/open", {
      handleId: "shared-id",
      path: "file:///workspace/first.txt",
    });
    await rpc(second, "fs/open", {
      handleId: "shared-id",
      path: "file:///workspace/second.txt",
    });

    await expect(
      rpc(first, "fs/readBlock", { handleId: "shared-id", offset: 0, len: 6 }),
    ).resolves.toEqual({ chunk: Buffer.from("first").toString("base64"), eof: true });
    await expect(
      rpc(second, "fs/readBlock", { handleId: "shared-id", offset: 0, len: 7 }),
    ).resolves.toEqual({ chunk: Buffer.from("second").toString("base64"), eof: true });
    await rpc(first, "fs/close", { handleId: "shared-id" });
    await expect(
      rpc(second, "fs/readBlock", { handleId: "shared-id", offset: 1, len: 2 }),
    ).resolves.toEqual({ chunk: Buffer.from("ec").toString("base64"), eof: false });

    first.close();
    second.close();
  });

  it("enforces sandbox read policy before opening a streamed file", async () => {
    const readFile = vi.fn(async () => Buffer.from("secret"));
    const sandbox = createSandboxContext({ readFile });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "fs/open", {
        handleId: "denied",
        path: "file:///workspace/private/secret.txt",
        sandbox: codexFsSandboxContext({
          entries: [
            { path: specialPath("root"), access: "read" },
            { path: globPath("private/*.txt"), access: "deny" },
          ],
        }),
      }),
    ).rejects.toThrow("Codex fs sandbox denied read access");
    expect(readFile).not.toHaveBeenCalled();
    socket.close();
  });

  it("rejects duplicate, oversized, and invalid sandbox file read handles", async () => {
    const data = Buffer.from("bounded");
    const sandbox = createSandboxContext({
      readFile: async () => data,
      stat: async () => ({ type: "file", size: data.byteLength, mtimeMs: 1 }),
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    const path = "file:///workspace/bounded.txt";
    await rpc(socket, "fs/open", { handleId: "bounded", path });
    await expect(rpc(socket, "fs/open", { handleId: "bounded", path })).rejects.toMatchObject({
      code: -32600,
    });
    await expect(rpc(socket, "fs/open", { handleId: "x".repeat(33), path })).rejects.toMatchObject({
      code: -32600,
    });
    for (const params of [
      { handleId: "bounded", offset: -1, len: 1 },
      { handleId: "bounded", offset: 0, len: 0 },
      { handleId: "bounded", offset: 0, len: 1024 * 1024 + 1 },
    ]) {
      await expect(rpc(socket, "fs/readBlock", params)).rejects.toMatchObject({ code: -32600 });
    }
    await expect(
      rpc(socket, "fs/readBlock", { handleId: "missing", offset: 0, len: 1 }),
    ).rejects.toMatchObject({ code: -32004 });
    socket.close();
  });

  it("rejects buffered sandbox file handles above the connection memory budget", async () => {
    const readFile = vi.fn(async () => Buffer.from("not read"));
    const sandbox = createSandboxContext({
      readFile,
      stat: async () => ({ type: "file", size: 64 * 1024 * 1024 + 1, mtimeMs: 1 }),
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "fs/open", { handleId: "oversized", path: "file:///workspace/oversized.bin" }),
    ).rejects.toMatchObject({
      code: -32600,
      message: "sandbox file read exceeds the per-connection buffered file limit",
    });
    expect(readFile).not.toHaveBeenCalled();
    socket.close();
  });

  it("bounds grown sandbox files to their pre-reserved size and releases failed handles", async () => {
    const readFile = vi
      .fn(async (_params: { filePath: string; maxBytes?: number }) => Buffer.from("small"))
      .mockResolvedValueOnce(Buffer.from("grown!"));
    const sandbox = createSandboxContext({
      readFile,
      stat: async () => ({ type: "file", size: 5, mtimeMs: 1 }),
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    const params = { handleId: "growing", path: "file:///workspace/growing.txt" };
    await expect(rpc(socket, "fs/open", params)).rejects.toMatchObject({
      code: -32600,
      message: "sandbox file read exceeds the per-connection buffered file limit",
    });
    expect(readFile).toHaveBeenNthCalledWith(1, {
      filePath: "/workspace/growing.txt",
      maxBytes: 5,
      signal: expect.any(AbortSignal),
    });
    await expect(rpc(socket, "fs/open", params)).resolves.toEqual({ handleId: "growing" });
    await expect(
      rpc(socket, "fs/readBlock", { handleId: "growing", offset: 0, len: 5 }),
    ).resolves.toEqual({ chunk: Buffer.from("small").toString("base64"), eof: true });
    socket.close();
  });

  it("reserves concurrent sandbox file reads before any asynchronous bridge read", async () => {
    const halfBudget = 32 * 1024 * 1024;
    const releaseReads = new Map<string, (data: Buffer) => void>();
    const readFile = vi.fn(
      ({ filePath }: { filePath: string; maxBytes?: number }) =>
        new Promise<Buffer>((resolve) => {
          releaseReads.set(filePath, resolve);
        }),
    );
    const sandbox = createSandboxContext({
      readFile,
      stat: async () => ({ type: "file", size: halfBudget, mtimeMs: 1 }),
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    const first = rpc(socket, "fs/open", {
      handleId: "first",
      path: "file:///workspace/first.txt",
    });
    const second = rpc(socket, "fs/open", {
      handleId: "second",
      path: "file:///workspace/second.txt",
    });
    await vi.waitFor(() => {
      expect(readFile).toHaveBeenCalledTimes(2);
    });
    expect(readFile).toHaveBeenNthCalledWith(1, {
      filePath: "/workspace/first.txt",
      maxBytes: halfBudget,
      signal: expect.any(AbortSignal),
    });
    expect(readFile).toHaveBeenNthCalledWith(2, {
      filePath: "/workspace/second.txt",
      maxBytes: halfBudget,
      signal: expect.any(AbortSignal),
    });

    await expect(
      rpc(socket, "fs/open", {
        handleId: "overflow",
        path: "file:///workspace/overflow.txt",
      }),
    ).rejects.toMatchObject({
      code: -32600,
      message: "sandbox file read exceeds the per-connection buffered file limit",
    });
    expect(readFile).toHaveBeenCalledTimes(2);

    releaseReads.get("/workspace/first.txt")?.(Buffer.from("first"));
    releaseReads.get("/workspace/second.txt")?.(Buffer.from("second"));
    await expect(first).resolves.toEqual({ handleId: "first" });
    await expect(second).resolves.toEqual({ handleId: "second" });
    socket.close();
  });

  it("caps pending sandbox stats and retains their slots until cancellation settles", async () => {
    const releaseStats = new Map<
      string,
      (stat: { type: "file"; size: number; mtimeMs: number }) => void
    >();
    const signals: AbortSignal[] = [];
    const stat = vi.fn(
      ({ filePath, signal }: { filePath: string; signal?: AbortSignal }) =>
        new Promise<{ type: "file"; size: number; mtimeMs: number }>((resolve) => {
          if (signal) {
            signals.push(signal);
          }
          releaseStats.set(filePath, resolve);
        }),
    );
    const readFile = vi.fn(async () => Buffer.from("never read"));
    const sandbox = createSandboxContext({ readFile, stat });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    const responses = new Map<number, { error?: { code: number } }>();
    socket.on("message", (data) => {
      const response = JSON.parse(Buffer.from(data as Buffer).toString("utf8")) as {
        id?: number;
        error?: { code: number };
      };
      if (typeof response.id === "number") {
        responses.set(response.id, response);
      }
    });
    for (let index = 0; index < 128; index += 1) {
      socket.send(
        JSON.stringify({
          id: 20_000 + index,
          method: "fs/open",
          params: {
            handleId: `stat-${index}`,
            path: `file:///workspace/stat-${index}.bin`,
          },
        }),
      );
    }
    await vi.waitFor(() => {
      expect(stat).toHaveBeenCalledTimes(128);
    });
    expect(signals).toHaveLength(128);
    expect(readFile).not.toHaveBeenCalled();

    await expect(rpc(socket, "fs/close", { handleId: "stat-0" })).resolves.toEqual({});
    expect(signals[0]?.aborted).toBe(true);
    await expect(
      rpc(socket, "fs/open", {
        handleId: "stat-0",
        path: "file:///workspace/reused.bin",
      }),
    ).rejects.toMatchObject({ code: -32600 });
    await expect(
      rpc(socket, "fs/open", {
        handleId: "stat-overflow",
        path: "file:///workspace/overflow.bin",
      }),
    ).rejects.toMatchObject({
      code: -32600,
      message: "at most 128 file reads may be open per connection",
    });
    expect(stat).toHaveBeenCalledTimes(128);
    expect(readFile).not.toHaveBeenCalled();

    releaseStats.get("/workspace/stat-0.bin")?.({ type: "file", size: 1, mtimeMs: 1 });
    await vi.waitFor(() => {
      expect(responses.get(20_000)?.error?.code).toBe(-32004);
    });
    socket.send(
      JSON.stringify({
        id: 30_000,
        method: "fs/open",
        params: { handleId: "stat-0", path: "file:///workspace/recovered.bin" },
      }),
    );
    await vi.waitFor(() => {
      expect(stat).toHaveBeenCalledTimes(129);
    });
    expect(readFile).not.toHaveBeenCalled();

    const disconnected = waitForSocketClose(socket);
    socket.close();
    await disconnected;
    await vi.waitFor(() => {
      expect(signals).toHaveLength(129);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    });
    for (const releaseStat of releaseStats.values()) {
      releaseStat({ type: "file", size: 1, mtimeMs: 1 });
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("retains closed in-flight reservations until their sandbox reads settle", async () => {
    const halfBudget = 32 * 1024 * 1024;
    const releaseReads = new Map<string, (data: Buffer) => void>();
    const readFile = vi.fn(
      ({ filePath }: { filePath: string; maxBytes?: number; signal?: AbortSignal }) =>
        new Promise<Buffer>((resolve) => {
          releaseReads.set(filePath, resolve);
        }),
    );
    const sandbox = createSandboxContext({
      readFile,
      stat: async () => ({ type: "file", size: halfBudget, mtimeMs: 1 }),
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    const first = rpc(socket, "fs/open", {
      handleId: "first",
      path: "file:///workspace/first.txt",
    });
    await vi.waitFor(() => {
      expect(readFile).toHaveBeenCalledTimes(1);
    });
    const firstSignal = readFile.mock.calls[0]?.[0].signal;
    await expect(rpc(socket, "fs/close", { handleId: "first" })).resolves.toEqual({});
    expect(firstSignal?.aborted).toBe(true);
    await expect(
      rpc(socket, "fs/readBlock", { handleId: "first", offset: 0, len: 1 }),
    ).rejects.toMatchObject({ code: -32004 });
    await expect(
      rpc(socket, "fs/open", {
        handleId: "first",
        path: "file:///workspace/first.txt",
      }),
    ).rejects.toMatchObject({ code: -32600 });

    const second = rpc(socket, "fs/open", {
      handleId: "second",
      path: "file:///workspace/second.txt",
    });
    await vi.waitFor(() => {
      expect(readFile).toHaveBeenCalledTimes(2);
    });
    await expect(rpc(socket, "fs/close", { handleId: "second" })).resolves.toEqual({});
    expect(readFile.mock.calls[1]?.[0].signal?.aborted).toBe(true);
    await expect(
      rpc(socket, "fs/open", {
        handleId: "overflow",
        path: "file:///workspace/overflow.txt",
      }),
    ).rejects.toMatchObject({
      code: -32600,
      message: "sandbox file read exceeds the per-connection buffered file limit",
    });
    expect(readFile).toHaveBeenCalledTimes(2);

    const firstSettled = expect(first).rejects.toMatchObject({ code: -32004 });
    releaseReads.get("/workspace/first.txt")?.(Buffer.from("first"));
    await firstSettled;
    const secondSettled = expect(second).rejects.toMatchObject({ code: -32004 });
    releaseReads.get("/workspace/second.txt")?.(Buffer.from("second"));
    await secondSettled;

    const recovered = rpc(socket, "fs/open", {
      handleId: "first",
      path: "file:///workspace/first.txt",
    });
    await vi.waitFor(() => {
      expect(readFile).toHaveBeenCalledTimes(3);
    });
    releaseReads.get("/workspace/first.txt")?.(Buffer.from("first"));
    await expect(recovered).resolves.toEqual({ handleId: "first" });
    socket.close();
  });

  it("aborts pending reads and never starts new sandbox reads after socket disconnect", async () => {
    let releaseRead: ((data: Buffer) => void) | undefined;
    let releaseStat: ((stat: { type: "file"; size: number; mtimeMs: number }) => void) | undefined;
    const readFile = vi.fn(
      (_params: { filePath: string; maxBytes?: number; signal?: AbortSignal }) =>
        new Promise<Buffer>((resolve) => {
          releaseRead = resolve;
        }),
    );
    const stat = vi.fn(({ filePath }: { filePath: string }) => {
      if (filePath.endsWith("stat-pending.txt")) {
        return new Promise<{ type: "file"; size: number; mtimeMs: number }>((resolve) => {
          releaseStat = resolve;
        });
      }
      return Promise.resolve({ type: "file" as const, size: 5, mtimeMs: 1 });
    });
    const sandbox = createSandboxContext({ readFile, stat });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    socket.send(
      JSON.stringify({
        id: 1,
        method: "fs/open",
        params: { handleId: "pending", path: "file:///workspace/pending.txt" },
      }),
    );
    await vi.waitFor(() => {
      expect(readFile).toHaveBeenCalledTimes(1);
    });
    const signal = readFile.mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);

    socket.send(
      JSON.stringify({
        id: 2,
        method: "fs/open",
        params: { handleId: "stat-pending", path: "file:///workspace/stat-pending.txt" },
      }),
    );
    await vi.waitFor(() => {
      expect(stat).toHaveBeenCalledTimes(2);
    });

    const disconnected = waitForSocketClose(socket);
    socket.close();
    await disconnected;
    // The client can close before the server observes and cancels the peer connection.
    await vi.waitFor(() => {
      expect(signal?.aborted).toBe(true);
    });
    releaseStat?.({ type: "file", size: 5, mtimeMs: 1 });
    releaseRead?.(Buffer.from("small"));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});
