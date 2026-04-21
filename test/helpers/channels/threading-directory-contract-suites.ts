import { expect, it } from "vitest";
import type {
  ChannelDirectoryEntry,
  ChannelFocusedBindingContext,
  ChannelReplyTransport,
  ChannelThreadingToolContext,
} from "../../../src/channels/plugins/types.core.js";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { RuntimeEnv } from "../../../src/runtime.js";

let contractRuntime: RuntimeEnv | undefined;

async function getDirectoryContractRuntime(): Promise<RuntimeEnv> {
  if (contractRuntime) {
    return contractRuntime;
  }
  const { createNonExitingRuntime } = await import("../../../src/runtime.js");
  contractRuntime = createNonExitingRuntime();
  return contractRuntime;
}

function expectDirectoryEntryShape(entry: ChannelDirectoryEntry) {
  expect(["user", "group", "channel"]).toContain(entry.kind);
  expect(typeof entry.id).toBe("string");
  expect(entry.id.trim()).not.toBe("");
  if (entry.name !== undefined) {
    expect(typeof entry.name).toBe("string");
  }
  if (entry.handle !== undefined) {
    expect(typeof entry.handle).toBe("string");
  }
  if (entry.avatarUrl !== undefined) {
    expect(typeof entry.avatarUrl).toBe("string");
  }
  if (entry.rank !== undefined) {
    expect(typeof entry.rank).toBe("number");
  }
}

function expectThreadingToolContextShape(context: ChannelThreadingToolContext) {
  if (context.currentChannelId !== undefined) {
    expect(typeof context.currentChannelId).toBe("string");
  }
  if (context.currentChannelProvider !== undefined) {
    expect(typeof context.currentChannelProvider).toBe("string");
  }
  if (context.currentThreadTs !== undefined) {
    expect(typeof context.currentThreadTs).toBe("string");
  }
  if (context.currentMessageId !== undefined) {
    expect(["string", "number"]).toContain(typeof context.currentMessageId);
  }
  if (context.replyToMode !== undefined) {
    expect(["off", "first", "all"]).toContain(context.replyToMode);
  }
  if (context.hasRepliedRef !== undefined) {
    expect(typeof context.hasRepliedRef).toBe("object");
  }
  if (context.skipCrossContextDecoration !== undefined) {
    expect(typeof context.skipCrossContextDecoration).toBe("boolean");
  }
}

function expectReplyTransportShape(transport: ChannelReplyTransport) {
  if (transport.replyToId !== undefined && transport.replyToId !== null) {
    expect(typeof transport.replyToId).toBe("string");
  }
  if (transport.threadId !== undefined && transport.threadId !== null) {
    expect(["string", "number"]).toContain(typeof transport.threadId);
  }
}

function expectFocusedBindingShape(binding: ChannelFocusedBindingContext) {
  expect(typeof binding.conversationId).toBe("string");
  expect(binding.conversationId.trim()).not.toBe("");
  if (binding.parentConversationId !== undefined) {
    expect(typeof binding.parentConversationId).toBe("string");
  }
  expect(["current", "child"]).toContain(binding.placement);
  expect(typeof binding.labelNoun).toBe("string");
  expect(binding.labelNoun.trim()).not.toBe("");
}

export function installChannelThreadingContractSuite(params: {
  plugin: Pick<ChannelPlugin, "id" | "threading">;
}) {
  it("exposes the base threading contract", () => {
    expect(params.plugin.threading).toBeDefined();
  });

  it("keeps threading return values normalized", () => {
    const threading = params.plugin.threading;
    expect(threading).toBeDefined();

    if (threading?.resolveReplyToMode) {
      expect(
        ["off", "first", "all"].includes(
          threading.resolveReplyToMode({
            cfg: {} as OpenClawConfig,
            accountId: "default",
            chatType: "group",
          }),
        ),
      ).toBe(true);
    }

    const repliedRef = { value: false };
    const toolContext = threading?.buildToolContext?.({
      cfg: {} as OpenClawConfig,
      accountId: "default",
      context: {
        Channel: "group:test",
        From: "user:test",
        To: "group:test",
        ChatType: "group",
        CurrentMessageId: "msg-1",
        ReplyToId: "msg-0",
        ReplyToIdFull: "thread-0",
        MessageThreadId: "thread-0",
        NativeChannelId: "native:test",
      },
      hasRepliedRef: repliedRef,
    });

    if (toolContext) {
      expectThreadingToolContextShape(toolContext);
      if (toolContext.hasRepliedRef) {
        expect(toolContext.hasRepliedRef).toBe(repliedRef);
      }
    }

    const autoThreadId = threading?.resolveAutoThreadId?.({
      cfg: {} as OpenClawConfig,
      accountId: "default",
      to: "group:test",
      toolContext,
      replyToId: null,
    });
    if (autoThreadId !== undefined) {
      expect(typeof autoThreadId).toBe("string");
      expect(autoThreadId.trim()).not.toBe("");
    }

    const replyTransport = threading?.resolveReplyTransport?.({
      cfg: {} as OpenClawConfig,
      accountId: "default",
      threadId: "thread-0",
      replyToId: "msg-0",
    });
    if (replyTransport) {
      expectReplyTransportShape(replyTransport);
    }

    const focusedBinding = threading?.resolveFocusedBinding?.({
      cfg: {} as OpenClawConfig,
      accountId: "default",
      context: {
        Channel: "group:test",
        From: "user:test",
        To: "group:test",
        ChatType: "group",
        CurrentMessageId: "msg-1",
        ReplyToId: "msg-0",
        ReplyToIdFull: "thread-0",
        MessageThreadId: "thread-0",
        NativeChannelId: "native:test",
      },
    });
    if (focusedBinding) {
      expectFocusedBindingShape(focusedBinding);
    }
  });
}

export function installChannelDirectoryContractSuite(params: {
  plugin: Pick<ChannelPlugin, "id" | "directory">;
  coverage?: "lookups" | "presence";
  cfg?: OpenClawConfig;
  accountId?: string;
}) {
  it("exposes the base directory contract", async () => {
    const directory = params.plugin.directory;
    expect(directory).toBeDefined();

    if (params.coverage === "presence") {
      return;
    }
    const runtime = await getDirectoryContractRuntime();
    const self = await directory?.self?.({
      cfg: params.cfg ?? ({} as OpenClawConfig),
      accountId: params.accountId ?? "default",
      runtime,
    });
    if (self) {
      expectDirectoryEntryShape(self);
    }

    const peers =
      (await directory?.listPeers?.({
        cfg: params.cfg ?? ({} as OpenClawConfig),
        accountId: params.accountId ?? "default",
        query: "",
        limit: 5,
        runtime,
      })) ?? [];
    expect(Array.isArray(peers)).toBe(true);
    for (const peer of peers) {
      expectDirectoryEntryShape(peer);
    }

    const groups =
      (await directory?.listGroups?.({
        cfg: params.cfg ?? ({} as OpenClawConfig),
        accountId: params.accountId ?? "default",
        query: "",
        limit: 5,
        runtime,
      })) ?? [];
    expect(Array.isArray(groups)).toBe(true);
    for (const group of groups) {
      expectDirectoryEntryShape(group);
    }

    if (directory?.listGroupMembers && groups[0]?.id) {
      const members = await directory.listGroupMembers({
        cfg: params.cfg ?? ({} as OpenClawConfig),
        accountId: params.accountId ?? "default",
        groupId: groups[0].id,
        limit: 5,
        runtime,
      });
      expect(Array.isArray(members)).toBe(true);
      for (const member of members) {
        expectDirectoryEntryShape(member);
      }
    }
  });
}
