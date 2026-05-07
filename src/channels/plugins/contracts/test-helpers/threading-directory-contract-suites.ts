import { expect } from "vitest";
import type { OpenClawConfig } from "../../../../config/config.js";
import type { RuntimeEnv } from "../../../../runtime.js";
import type {
  ChannelDirectoryEntry,
  ChannelFocusedBindingContext,
  ChannelReplyTransport,
  ChannelThreadingToolContext,
} from "../../types.core.js";
import type { ChannelPlugin } from "../../types.js";

const contractRuntime = new Proxy(Object.create(null), {
  get(_target, property) {
    throw new Error(`Directory contract unexpectedly accessed runtime.${String(property)}`);
  },
}) as RuntimeEnv;

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

export function expectChannelThreadingBaseContract(
  plugin: Pick<ChannelPlugin, "id" | "threading">,
) {
  expect(plugin.threading).toBeDefined();
}

export function expectChannelThreadingReturnValuesNormalized(
  plugin: Pick<ChannelPlugin, "id" | "threading">,
) {
  const threading = plugin.threading;
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
}

export async function expectChannelDirectoryBaseContract(params: {
  plugin: Pick<ChannelPlugin, "id" | "directory">;
  coverage?: "lookups" | "presence";
  cfg?: OpenClawConfig;
  accountId?: string;
}) {
  const directory = params.plugin.directory;
  expect(directory).toBeDefined();
  const cfg =
    params.cfg ??
    ({
      channels: {
        [params.plugin.id]: { enabled: false },
      },
    } as unknown as OpenClawConfig);
  const accountId = params.accountId ?? "default";

  if (params.coverage === "presence") {
    return;
  }
  const self = await directory?.self?.({
    cfg,
    accountId,
    runtime: contractRuntime,
  });
  if (self) {
    expectDirectoryEntryShape(self);
  }

  const peers =
    (await directory?.listPeers?.({
      cfg,
      accountId,
      query: "",
      limit: 5,
      runtime: contractRuntime,
    })) ?? [];
  expect(Array.isArray(peers)).toBe(true);
  for (const peer of peers) {
    expectDirectoryEntryShape(peer);
  }

  const groups =
    (await directory?.listGroups?.({
      cfg,
      accountId,
      query: "",
      limit: 5,
      runtime: contractRuntime,
    })) ?? [];
  expect(Array.isArray(groups)).toBe(true);
  for (const group of groups) {
    expectDirectoryEntryShape(group);
  }

  if (directory?.listGroupMembers && groups[0]?.id) {
    const members = await directory.listGroupMembers({
      cfg,
      accountId,
      groupId: groups[0].id,
      limit: 5,
      runtime: contractRuntime,
    });
    expect(Array.isArray(members)).toBe(true);
    for (const member of members) {
      expectDirectoryEntryShape(member);
    }
  }
}
