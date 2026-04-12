import { expect, test } from "vitest";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { handleProcessSendKeys, type WritableStdin } from "./bash-tools.process-send-keys.js";

function createWritableStdinStub(): WritableStdin {
  return {
    write(_data: string, cb?: (err?: Error | null) => void) {
      cb?.();
    },
    end() {},
    destroyed: false,
  };
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

  expect(result.details).toMatchObject({ status: "failed" });
  expect(result.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("cursor key mode is not known yet"),
  });
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

  expect(result.details).toMatchObject({ status: "running" });
});
