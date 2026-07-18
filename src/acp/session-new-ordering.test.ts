import type { AnyMessage } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { AcpSessionNewOrdering } from "./session-new-ordering.js";

async function transformMessages(
  ordering: AcpSessionNewOrdering,
  messages: AnyMessage[],
): Promise<AnyMessage[]> {
  const stream = new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller) {
      ordering.transformOutbound(message, controller);
    },
  });
  const outputPromise = (async () => {
    const reader = stream.readable.getReader();
    const output: AnyMessage[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return output;
      }
      output.push(value);
    }
  })();
  const writer = stream.writable.getWriter();
  for (const message of messages) {
    await writer.write(message);
  }
  await writer.close();
  return outputPromise;
}

describe("AcpSessionNewOrdering", () => {
  it("emits a new-session result before updates that reference its session ID", async () => {
    const ordering = new AcpSessionNewOrdering();
    const update = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "new-session",
        update: { sessionUpdate: "session_info_update", title: "New session" },
      },
    } as AnyMessage;
    const result = {
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "new-session" },
    } as AnyMessage;

    await expect(transformMessages(ordering, [update, result])).resolves.toEqual([result, update]);
  });

  it("does not delay updates for a session ID supplied by the client", async () => {
    const ordering = new AcpSessionNewOrdering();
    ordering.observeInbound({
      jsonrpc: "2.0",
      id: 3,
      method: "session/load",
      params: { sessionId: "existing-session", cwd: "/tmp" },
    } as AnyMessage);
    const update = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "existing-session",
        update: { sessionUpdate: "session_info_update", title: "Existing session" },
      },
    } as AnyMessage;

    await expect(transformMessages(ordering, [update])).resolves.toEqual([update]);
  });
});
