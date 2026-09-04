import { once } from "node:events";
import process from "node:process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { disposeMcpClient } from "./mcp-client-lifecycle.js";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";
import { resolveMcpTransport } from "./mcp-transport.js";

const { logDebug } = vi.hoisted(() => ({ logDebug: vi.fn() }));
vi.mock("../logger.js", () => ({ logDebug }));

function createStderrProbe(args?: string[]) {
  const resolved = resolveMcpTransport("probe", { command: process.execPath, args });
  if (!resolved || !(resolved.transport instanceof OpenClawStdioClientTransport)) {
    throw new Error("Expected a stdio transport");
  }
  const stderr = resolved.transport.stderr;
  if (!(stderr instanceof PassThrough)) {
    throw new Error("Expected a writable stderr test pipe");
  }
  return { ...resolved, transport: resolved.transport, stderr };
}

describe("MCP stderr diagnostics", () => {
  afterEach(() => {
    vi.useRealTimers();
    logDebug.mockClear();
  });

  it("joins a diagnostic split at every UTF-8 byte boundary", () => {
    const probe = createStderrProbe();
    try {
      for (const byte of Buffer.from("alpha 你好 😀 omega\r\n")) {
        probe.stderr.write(Buffer.from([byte]));
      }
      expect(logDebug.mock.calls).toEqual([["bundle-mcp:probe: alpha 你好 😀 omega"]]);
    } finally {
      probe.detachStderr?.();
    }
  });

  it("reports sustained newline-free progress without waiting for an idle gap", () => {
    vi.useFakeTimers();
    const probe = createStderrProbe();
    try {
      for (let index = 0; index < 3; index++) {
        probe.stderr.write("loading ");
        vi.advanceTimersByTime(index === 2 ? 50 : 100);
      }
      expect(logDebug.mock.calls).toEqual([["bundle-mcp:probe: loading loading loading"]]);
    } finally {
      probe.detachStderr?.();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps incomplete UTF-8 bytes across a progress flush", () => {
    vi.useFakeTimers();
    const probe = createStderrProbe();
    try {
      const bytes = Buffer.from("loading 你");
      probe.stderr.write(bytes.subarray(0, -1));
      vi.advanceTimersByTime(250);
      expect(logDebug.mock.calls).toEqual([["bundle-mcp:probe: loading"]]);
      probe.stderr.write(bytes.subarray(-1));
      probe.stderr.write("\n");
      expect(logDebug.mock.calls).toEqual([
        ["bundle-mcp:probe: loading"],
        ["bundle-mcp:probe: 你"],
      ]);
    } finally {
      probe.detachStderr?.();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("emits CR progress frames without duplicating a split CRLF", () => {
    const probe = createStderrProbe();
    try {
      probe.stderr.write("start\rmiddle\r");
      probe.stderr.write("\nlast");
      probe.detachStderr?.();
      expect(logDebug.mock.calls).toEqual([
        ["bundle-mcp:probe: start"],
        ["bundle-mcp:probe: middle"],
        ["bundle-mcp:probe: last"],
      ]);
    } finally {
      probe.detachStderr?.();
    }
  });

  it.each(["newline", "detach"])("marks a UTF-8-safe bounded tail on %s", (ending) => {
    const probe = createStderrProbe();
    try {
      probe.stderr.write(`xx😀${"y".repeat(4000)}`);
      probe.stderr.write("y".repeat(4189));
      if (ending === "newline") {
        probe.stderr.write("\n");
      }
      probe.detachStderr?.();
      expect(logDebug.mock.calls).toEqual([
        [`bundle-mcp:probe: [stderr line truncated] ${"y".repeat(8189)}`],
      ]);
    } finally {
      probe.detachStderr?.();
    }
  });

  it("flushes natural EOF once and releases its listeners", async () => {
    const probe = createStderrProbe();
    try {
      const ended = once(probe.stderr, "end");
      probe.stderr.end("fatal tail");
      await ended;
      probe.detachStderr?.();
      expect(logDebug.mock.calls).toEqual([["bundle-mcp:probe: fatal tail"]]);
      for (const event of ["data", "end", "close"]) {
        expect(probe.stderr.listenerCount(event)).toBe(0);
      }
    } finally {
      probe.detachStderr?.();
    }
  });

  it("keeps diagnostics attached through forced disposal", async () => {
    vi.useFakeTimers();
    const probe = createStderrProbe();
    const close = vi
      .spyOn(probe.transport, "close")
      .mockImplementation(() => new Promise(() => {}));
    const forceClose = vi.spyOn(probe.transport, "forceClose").mockImplementation(async () => {
      probe.stderr.write("forced shutdown tail");
    });
    try {
      const disposing = disposeMcpClient({ ...probe, client: { close: async () => {} } }, 50);
      await vi.advanceTimersByTimeAsync(50);
      await disposing;
      expect(forceClose).toHaveBeenCalledOnce();
      expect(logDebug.mock.calls).toEqual([["bundle-mcp:probe: forced shutdown tail"]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      close.mockRestore();
      forceClose.mockRestore();
      probe.detachStderr?.();
    }
  });

  it("retains a real child process's unterminated shutdown diagnostic", async () => {
    const probe = createStderrProbe([
      "-e",
      `process.stdin.resume();
       process.stdin.on("end", () => {
         const message = Buffer.from("shutdown 你好");
         process.stderr.write(message.subarray(0, 10));
         setImmediate(() => process.stderr.end(message.subarray(10)));
       });`,
    ]);
    try {
      await probe.transport.start();
      await disposeMcpClient({ ...probe, client: { close: async () => {} } });
      expect(logDebug.mock.calls).toEqual([["bundle-mcp:probe: shutdown 你好"]]);
      expect(probe.transport.pid).toBeNull();
    } finally {
      await probe.transport.forceClose();
      probe.detachStderr?.();
    }
  });
});
