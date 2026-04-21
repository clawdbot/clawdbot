import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  pinActivePluginChannelRegistry,
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  __testing,
  getSessionBindingService,
  isSessionBindingError,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingBindInput,
  type SessionBindingRecord,
} from "./session-binding-service.js";

type SessionBindingServiceModule = typeof import("./session-binding-service.js");

const sessionBindingServiceModuleUrl = new URL("./session-binding-service.ts", import.meta.url)
  .href;

function setMinimalCurrentConversationRegistry(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "workspace",
        source: "test",
        plugin: {
          id: "workspace",
          meta: { aliases: [] },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
          },
        },
      },
      {
        pluginId: "teamchat",
        source: "test",
        plugin: {
          id: "teamchat",
          meta: { aliases: [] },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
          },
        },
      },
    ]),
  );
}

async function importSessionBindingServiceModule(
  cacheBust: string,
): Promise<SessionBindingServiceModule> {
  return (await import(
    `${sessionBindingServiceModuleUrl}?t=${cacheBust}`
  )) as SessionBindingServiceModule;
}

function createRecord(input: SessionBindingBindInput): SessionBindingRecord {
  const conversationId =
    input.placement === "child"
      ? "thread-created"
      : input.conversation.conversationId.trim() || "thread-current";
  return {
    bindingId: `default:${conversationId}`,
    targetSessionKey: input.targetSessionKey,
    targetKind: input.targetKind,
    conversation: {
      channel: "demo-binding",
      accountId: "default",
      conversationId,
      parentConversationId: input.conversation.parentConversationId?.trim() || undefined,
    },
    status: "active",
    boundAt: 1,
  };
}

describe("session binding service", () => {
  beforeEach(() => {
    __testing.resetSessionBindingAdaptersForTests();
    setMinimalCurrentConversationRegistry();
  });

  it("normalizes conversation refs and infers current placement", async () => {
    const bind = vi.fn(async (input: SessionBindingBindInput) => createRecord(input));
    registerSessionBindingAdapter({
      channel: "demo-binding",
      accountId: "default",
      bind,
      listBySession: () => [],
      resolveByConversation: () => null,
    });

    const result = await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-1",
      targetKind: "subagent",
      conversation: {
        channel: "Demo-Binding",
        accountId: "DEFAULT",
        conversationId: " thread-1 ",
      },
    });

    expect(result.conversation.channel).toBe("demo-binding");
    expect(result.conversation.accountId).toBe("default");
    expect(bind).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "current",
        conversation: expect.objectContaining({
          channel: "demo-binding",
          accountId: "default",
          conversationId: "thread-1",
        }),
      }),
    );
  });

  it("supports explicit child placement when adapter advertises it", async () => {
    registerSessionBindingAdapter({
      channel: "demo-binding",
      accountId: "default",
      capabilities: { placements: ["child"] },
      bind: async (input) => createRecord(input),
      listBySession: () => [],
      resolveByConversation: () => null,
    });

    const result = await getSessionBindingService().bind({
      targetSessionKey: "agent:codex:acp:1",
      targetKind: "session",
      conversation: {
        channel: "demo-binding",
        accountId: "default",
        conversationId: "thread-1",
      },
      placement: "child",
    });

    expect(result.conversation.conversationId).toBe("thread-created");
  });

  it("returns structured errors when adapter is unavailable", async () => {
    await expect(
      getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-1",
        targetKind: "subagent",
        conversation: {
          channel: "demo-binding",
          accountId: "default",
          conversationId: "thread-1",
        },
      }),
    ).rejects.toMatchObject({
      code: "BINDING_ADAPTER_UNAVAILABLE",
    });
  });

  it("returns structured errors for unsupported placement", async () => {
    registerSessionBindingAdapter({
      channel: "demo-binding",
      accountId: "default",
      capabilities: { placements: ["current"] },
      bind: async (input) => createRecord(input),
      listBySession: () => [],
      resolveByConversation: () => null,
    });

    const rejected = await getSessionBindingService()
      .bind({
        targetSessionKey: "agent:codex:acp:1",
        targetKind: "session",
        conversation: {
          channel: "demo-binding",
          accountId: "default",
          conversationId: "thread-1",
        },
        placement: "child",
      })
      .catch((error) => error);

    expect(isSessionBindingError(rejected)).toBe(true);
    expect(rejected).toMatchObject({
      code: "BINDING_CAPABILITY_UNSUPPORTED",
      details: {
        placement: "child",
      },
    });
  });

  it("returns structured errors when adapter bind fails", async () => {
    registerSessionBindingAdapter({
      channel: "demo-binding",
      accountId: "default",
      bind: async () => null,
      listBySession: () => [],
      resolveByConversation: () => null,
    });

    await expect(
      getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-1",
        targetKind: "subagent",
        conversation: {
          channel: "demo-binding",
          accountId: "default",
          conversationId: "thread-1",
        },
      }),
    ).rejects.toMatchObject({
      code: "BINDING_CREATE_FAILED",
    });
  });

  it("reports adapter capabilities for command preflight messaging", () => {
    registerSessionBindingAdapter({
      channel: "demo-binding",
      accountId: "default",
      capabilities: {
        placements: ["current", "child"],
      },
      bind: async (input) => createRecord(input),
      listBySession: () => [],
      resolveByConversation: () => null,
      unbind: async () => [],
    });

    const known = getSessionBindingService().getCapabilities({
      channel: "demo-binding",
      accountId: "default",
    });
    const unknown = getSessionBindingService().getCapabilities({
      channel: "demo-binding",
      accountId: "other",
    });

    expect(known).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    });
    expect(unknown).toEqual({
      adapterAvailable: false,
      bindSupported: false,
      unbindSupported: false,
      placements: [],
    });
  });

  it("falls back to generic current-conversation bindings for registered channels", async () => {
    const service = getSessionBindingService();

    expect(
      service.getCapabilities({
        channel: "Workspace",
        accountId: " DEFAULT ",
      }),
    ).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    });

    const bound = await service.bind({
      targetSessionKey: "agent:codex:acp:workspace-dm",
      targetKind: "session",
      conversation: {
        channel: " Workspace ",
        accountId: " DEFAULT ",
        conversationId: " user:U123 ",
      },
      metadata: {
        label: "workspace-dm",
      },
      ttlMs: 60_000,
    });

    expect(bound).toMatchObject({
      bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
      targetKind: "session",
      conversation: {
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
      },
      status: "active",
      metadata: expect.objectContaining({
        label: "workspace-dm",
      }),
    });

    const resolved = service.resolveByConversation({
      channel: "workspace",
      accountId: "default",
      conversationId: "user:U123",
    });
    expect(resolved).toMatchObject({
      bindingId: bound.bindingId,
      targetSessionKey: "agent:codex:acp:workspace-dm",
    });
    expect(service.listBySession("agent:codex:acp:workspace-dm")).toEqual([resolved]);

    service.touch(bound.bindingId, 1234);
    expect(
      service.resolveByConversation({
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
      })?.metadata,
    ).toEqual(
      expect.objectContaining({
        label: "workspace-dm",
        lastActivityAt: 1234,
      }),
    );

    await expect(
      service.unbind({
        targetSessionKey: "agent:codex:acp:workspace-dm",
        reason: "test cleanup",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        bindingId: bound.bindingId,
      }),
    ]);
    expect(
      service.resolveByConversation({
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
      }),
    ).toBeNull();
  });

  it("supports registered plugin channels through the generic current-conversation path", async () => {
    const service = getSessionBindingService();

    expect(
      service.getCapabilities({
        channel: "teamchat",
        accountId: "default",
      }),
    ).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    });

    await expect(
      service.bind({
        targetSessionKey: "agent:codex:acp:teamchat-room",
        targetKind: "session",
        conversation: {
          channel: "teamchat",
          accountId: "default",
          conversationId: "19:chatid@thread.v2",
        },
        placement: "child",
      }),
    ).rejects.toMatchObject({
      code: "BINDING_CAPABILITY_UNSUPPORTED",
      details: {
        channel: "teamchat",
        accountId: "default",
        placement: "child",
      },
    });

    await expect(
      service.bind({
        targetSessionKey: "agent:codex:acp:teamchat-room",
        targetKind: "session",
        conversation: {
          channel: "teamchat",
          accountId: "default",
          conversationId: "19:chatid@thread.v2",
        },
      }),
    ).resolves.toMatchObject({
      conversation: {
        channel: "teamchat",
        accountId: "default",
        conversationId: "19:chatid@thread.v2",
      },
    });
  });

  it("does not advertise generic plugin bindings from a stale global registry when the active channel registry is empty", async () => {
    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.channels.push({
      plugin: {
        id: "external-chat",
        meta: { aliases: ["external-chat-alias"] },
      } as never,
    } as never);
    setActivePluginRegistry(activeRegistry);
    const pinnedEmptyChannelRegistry = createEmptyPluginRegistry();
    pinActivePluginChannelRegistry(pinnedEmptyChannelRegistry);

    try {
      const service = getSessionBindingService();
      expect(
        service.getCapabilities({
          channel: "external-chat-alias",
          accountId: "default",
        }),
      ).toEqual({
        adapterAvailable: false,
        bindSupported: false,
        unbindSupported: false,
        placements: [],
      });

      await expect(
        service.bind({
          targetSessionKey: "agent:codex:acp:external-chat",
          targetKind: "session",
          conversation: {
            channel: "external-chat-alias",
            accountId: "default",
            conversationId: "room-1",
          },
        }),
      ).rejects.toMatchObject({
        code: "BINDING_ADAPTER_UNAVAILABLE",
      });
    } finally {
      releasePinnedPluginChannelRegistry(pinnedEmptyChannelRegistry);
    }
  });

  it("keeps the newest live adapter authoritative until it unregisters", () => {
    const firstBinding = {
      bindingId: "first-binding",
      targetSessionKey: "agent:main",
      targetKind: "session" as const,
      conversation: {
        channel: "demo-binding",
        accountId: "default",
        conversationId: "thread-1",
      },
      status: "active" as const,
      boundAt: 1,
    };
    const firstAdapter: SessionBindingAdapter = {
      channel: "demo-binding",
      accountId: "default",
      listBySession: (targetSessionKey) =>
        targetSessionKey === "agent:main" ? [firstBinding] : [],
      resolveByConversation: () => null,
    };
    const secondBinding = {
      bindingId: "second-binding",
      targetSessionKey: "agent:main",
      targetKind: "session" as const,
      conversation: {
        channel: "demo-binding",
        accountId: "default",
        conversationId: "thread-2",
      },
      status: "active" as const,
      boundAt: 2,
    };
    const secondAdapter: SessionBindingAdapter = {
      channel: "Demo-Binding",
      accountId: "DEFAULT",
      listBySession: (targetSessionKey) =>
        targetSessionKey === "agent:main" ? [secondBinding] : [],
      resolveByConversation: () => null,
    };

    registerSessionBindingAdapter(firstAdapter);
    registerSessionBindingAdapter(secondAdapter);

    expect(getSessionBindingService().listBySession("agent:main")).toEqual([secondBinding]);

    unregisterSessionBindingAdapter({
      channel: "demo-binding",
      accountId: "default",
      adapter: secondAdapter,
    });

    expect(getSessionBindingService().listBySession("agent:main")).toEqual([firstBinding]);

    unregisterSessionBindingAdapter({
      channel: "demo-binding",
      accountId: "default",
      adapter: firstAdapter,
    });

    expect(getSessionBindingService().listBySession("agent:main")).toEqual([]);
  });

  it("shares registered adapters across duplicate module instances", async () => {
    const first = await importSessionBindingServiceModule(`first-${Date.now()}`);
    const second = await importSessionBindingServiceModule(`second-${Date.now()}`);
    const firstBind = vi.fn(async (input: SessionBindingBindInput) => createRecord(input));
    const secondBind = vi.fn(async (input: SessionBindingBindInput) => createRecord(input));
    const firstAdapter: SessionBindingAdapter = {
      channel: "demo-binding",
      accountId: "default",
      bind: firstBind,
      listBySession: () => [],
      resolveByConversation: () => null,
    };
    const secondAdapter: SessionBindingAdapter = {
      channel: "demo-binding",
      accountId: "default",
      bind: secondBind,
      listBySession: () => [],
      resolveByConversation: () => null,
    };

    first.__testing.resetSessionBindingAdaptersForTests();
    first.registerSessionBindingAdapter(firstAdapter);
    second.registerSessionBindingAdapter(secondAdapter);

    expect(second.__testing.getRegisteredAdapterKeys()).toEqual(["demo-binding:default"]);

    await expect(
      second.getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-1",
        targetKind: "subagent",
        conversation: {
          channel: "demo-binding",
          accountId: "default",
          conversationId: "thread-1",
        },
      }),
    ).resolves.toMatchObject({
      conversation: expect.objectContaining({
        channel: "demo-binding",
        accountId: "default",
        conversationId: "thread-1",
      }),
    });
    expect(firstBind).not.toHaveBeenCalled();
    expect(secondBind).toHaveBeenCalledTimes(1);

    second.unregisterSessionBindingAdapter({
      channel: "demo-binding",
      accountId: "default",
      adapter: secondAdapter,
    });

    await expect(
      second.getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-2",
        targetKind: "subagent",
        conversation: {
          channel: "demo-binding",
          accountId: "default",
          conversationId: "thread-2",
        },
      }),
    ).resolves.toMatchObject({
      conversation: expect.objectContaining({
        channel: "demo-binding",
        accountId: "default",
        conversationId: "thread-2",
      }),
    });
    expect(firstBind).toHaveBeenCalledTimes(1);
    expect(secondBind).toHaveBeenCalledTimes(1);

    first.unregisterSessionBindingAdapter({
      channel: "demo-binding",
      accountId: "default",
      adapter: firstAdapter,
    });

    await expect(
      second.getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-3",
        targetKind: "subagent",
        conversation: {
          channel: "demo-binding",
          accountId: "default",
          conversationId: "thread-3",
        },
      }),
    ).rejects.toMatchObject({
      code: "BINDING_ADAPTER_UNAVAILABLE",
    });

    first.__testing.resetSessionBindingAdaptersForTests();
  });
});
