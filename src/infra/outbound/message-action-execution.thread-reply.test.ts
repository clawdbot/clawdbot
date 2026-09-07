import { describe, expect, it } from "vitest";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { annotateSourceDelivery } from "./message-action-execution.js";

const actionParams = {
  action: "thread-reply",
  to: "direct:user-1",
  threadId: "thread-1",
  message: "visible reply",
};

const input = {
  cfg: {},
  action: "thread-reply" as const,
  params: { channel: "testchat", ...actionParams },
  messageActionAuthorization: {
    requesterAccountId: "default",
    toolContext: {
      currentChannelProvider: "testchat" as const,
      currentChannelId: "direct:user-1",
      currentThreadTs: "thread-1",
    },
  },
  sessionKey: "agent:main:testchat:direct:user-1",
  defaultAccountId: "default",
};

const annotationParams = {
  cfg: {},
  params: actionParams,
  channel: "testchat" as const,
  accountId: "default",
  input,
  dryRun: false,
  channelPlugin: createChannelTestPluginBase({ id: "testchat" }),
  mediaAccess: { localRoots: [] },
};

describe("annotateSourceDelivery thread replies", () => {
  it("marks a gateway-returned current-thread receipt", () => {
    const result = annotateSourceDelivery(
      {
        kind: "action" as const,
        channel: "testchat" as const,
        action: "thread-reply" as const,
        handledBy: "plugin" as const,
        payload: { receipt: { threadId: "thread-1" } },
        dryRun: false,
      },
      annotationParams,
      false,
    );

    expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
  });

  it("marks both payload and tool details after local plugin dispatch", () => {
    const receipt = { threadId: "thread-1" };
    const result = annotateSourceDelivery(
      {
        kind: "action" as const,
        channel: "testchat" as const,
        action: "thread-reply" as const,
        handledBy: "plugin" as const,
        payload: { receipt },
        toolResult: {
          content: [{ type: "text" as const, text: "delivered" }],
          details: { receipt },
        },
        dryRun: false,
      },
      annotationParams,
      false,
    );

    expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
    expect(result.toolResult.details).toMatchObject({ sourceReplyRoute: "current-source" });
  });

  it("leaves a different-thread receipt unmarked", () => {
    const result = annotateSourceDelivery(
      {
        kind: "action" as const,
        channel: "testchat" as const,
        action: "thread-reply" as const,
        handledBy: "plugin" as const,
        payload: { receipt: { threadId: "other-thread" } },
        dryRun: false,
      },
      annotationParams,
      false,
    );

    expect(result.payload).not.toHaveProperty("sourceReplyRoute");
  });
});
