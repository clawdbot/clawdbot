/**
 * Regression coverage for process send-keys cursor-mode handling.
 * Cursor-sensitive keys must wait until PTY startup output establishes mode.
 */
import { Writable } from "node:stream";
import { expect, test } from "vitest";
import { createManagedChildStdin } from "../process/supervisor/adapters/child-stdin.js";
import type { ManagedRunStdin } from "../process/supervisor/types.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { handleProcessSendKeys } from "./bash-tools.process-send-keys.js";

function createWritableStdinStub(): ManagedRunStdin {
  return {
    write(_data, cb) {
      cb?.();
    },
    end() {},
    destroyed: false,
  };
}

function expectTextContent(content: unknown, text: string) {
  const part = content as { type?: string; text?: string } | undefined;
  expect(part?.type).toBe("text");
  expect(part?.text).toContain(text);
}

test("process send-keys fails loud for unknown cursor mode when arrows depend on it", async () => {
  const result = await handleProcessSendKeys({
    sessionId: "sess-unknown-mode",
    session: createProcessSessionFixture({
      id: "sess-unknown-mode",
      command: "vim",
      backgrounded: true,
      cursorKeyMode: "unknown",
    }),
    stdin: createWritableStdinStub(),
    keys: ["up"],
  });

  expect((result.details as { status?: string }).status).toBe("failed");
  expectTextContent(result.content[0], "cursor key mode is not known yet");
});

test("process send-keys still sends non-cursor keys while mode is unknown", async () => {
  const result = await handleProcessSendKeys({
    sessionId: "sess-unknown-enter",
    session: createProcessSessionFixture({
      id: "sess-unknown-enter",
      command: "vim",
      backgrounded: true,
      cursorKeyMode: "unknown",
    }),
    stdin: createWritableStdinStub(),
    keys: ["Enter"],
  });

  expect((result.details as { status?: string }).status).toBe("running");
});

test.each([
  { name: "Unicode literal", input: { literal: "你好😀" }, expected: "e4bda0e5a5bdf09f9880" },
  { name: "raw hex", input: { hex: ["80", "ff", "00", "0x0a"] }, expected: "80ff000a" },
  {
    name: "mixed input",
    input: { literal: "é", hex: ["c3", "a9", "zz"], keys: ["C-c", "Enter"] },
    expected: "c3a9c3a9030d",
  },
  { name: "empty input", input: {}, expected: "" },
  { name: "invalid hex only", input: { hex: ["zz"] }, expected: "" },
])("process send-keys preserves $name bytes", async ({ input, expected }) => {
  const received: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      received.push(chunk);
      callback();
    },
  });
  const stdin = createManagedChildStdin(stream)!;
  try {
    const result = await handleProcessSendKeys({
      sessionId: "sess-input-bytes",
      session: createProcessSessionFixture({ id: "sess-input-bytes", command: "cat" }),
      stdin,
      ...input,
    });
    expect(Buffer.concat(received).toString("hex")).toBe(expected);
    expectTextContent(
      result.content[0],
      expected ? `Sent ${expected.length / 2} bytes` : "No key data provided.",
    );
    expect(result.details).toMatchObject({ status: expected ? "running" : "failed" });
  } finally {
    stream.destroy();
  }
});
