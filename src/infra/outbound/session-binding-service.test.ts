// Covers session binding adapter registration, generic current-conversation
// fallback, capability errors, deduping, and duplicate graph teardown.
import { expectDefined } from "@openclaw/normalization-core";
import {
  inspectConversationBinding as inspectSessionBindingByConversation,
  type ConversationBindingInspection,
} from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import {
  testing,
  getSessionBindingService,
  isSessionBindingError,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingBindInput,
  type SessionBindingRecord,
  type SessionBindingService,
} from "./session-binding-service.js";

type SessionBindingServiceModule = typeof import("./session-binding-service.js");

const sessionBindingServiceModuleUrl = new URL("./session-binding-service.ts", import.meta.url)
  .href;
const tempDirs = createTrackedTempDirs();

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
      {
        pluginId: "adapter-chat",
        source: "test",
        plugin: {
          id: "adapter-chat",
          meta: { aliases: [] },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
            bindingStore: "adapter",
          },
        },
      },
      {
        pluginId: "legacy-adapter-chat",
        source: "test",
        plugin: {
          id: "legacy-adapter-chat",
          meta: { aliases: [] },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
            createManager: () => ({ stop: () => undefined }),
          },
        },
      },
    ]),
  );
}

it("keeps the stable session-binding service shape structurally assignable", () => {
  const service: SessionBindingService = {
    bind: async () => {
      throw new Error("not implemented");
    },
    getCapabilities: () => ({
      adapterAvailable: false,
      bindSupported: false,
      unbindSupported: false,
      placements: [],
    }),
    listBySession: () => [],
    resolveByConversation: () => null,
    touch: () => {},
    unbind: async () => [],
  };

  expect(
    service.resolveByConversation({
      channel: "demo",
      accountId: "default",
      conversationId: "room-1",
    }),
  ).toBeNull();
});

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
    bindingId: `${input.conversation.accountId}:${conversationId}`,
    targetSessionKey: input.targetSessionKey,
    targetKind: input.targetKind,
    conversation: {
      channel: input.conversation.channel,
      accountId: input.conversation.accountId,
      conversationId,
      parentConversationId: input.conversation.parentConversationId?.trim() || undefined,
    },
    status: "active",
    boundAt: 1,
  };
}

const requireRecord = createRequireRecord("record", "expected-label-record");

function firstMockArg(
  mock: { mock: { calls: readonly unknown[][] } },
  label: string,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  return requireRecord(arg, `${label} input`);
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

async function expectSessionBindingError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    expect(requireRecord(error, "session binding error").code).toBe(code);
    return error;
  }
  throw new Error(`expected ${code} session binding error`);
}

function expectConversationFields(value: unknown, fields: Record<string, unknown>) {
  expectRecordFields(requireRecord(value, "conversation"), fields);
}

describe("session binding service", () => {
  let previousStateDir: string | undefined;
  let testStateDir = "";

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateDir = await tempDirs.make("openclaw-session-binding-");
    process.env.OPENCLAW_STATE_DIR = testStateDir;
    testing.resetSessionBindingAdaptersForTests();
    setMinimalCurrentConversationRegistry();
  });

  afterEach(async () => {
    testing.resetSessionBindingAdaptersForTests();
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await tempDirs.cleanup();
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
    const bindInput = firstMockArg(bind, "bind");
    expect(bindInput.placement).toBe("current");
    expectConversationFields(bindInput.conversation, {
      channel: "demo-binding",
      accountId: "default",
      conversationId: "thread-1",
    });
  });

  it("keeps colliding adapter ids scoped while session-wide cleanup reaches every owner", async () => {
    const service = getSessionBindingService();
    const bindings: SessionBindingRecord[] = [];
    for (const channel of ["channel-a", "channel-b"]) {
      let current: SessionBindingRecord | null = null;
      registerSessionBindingAdapter({
        channel,
        accountId: "default",
        bind: async (input) => (current = createRecord(input)),
        resolveByConversation: () => current,
        listBySession: (key) => (current?.targetSessionKey === key ? [current] : []),
        touch: (id, at) => {
          if (current?.bindingId === id) {
            current = { ...current, metadata: { lastActivityAt: at } };
          }
        },
        unbind: async (input) => {
          if (
            !current ||
            (input.bindingId !== current.bindingId &&
              input.targetSessionKey !== current.targetSessionKey)
          ) {
            return [];
          }
          const removed = current;
          current = null;
          return [removed];
        },
      });
      bindings.push(
        await service.bind({
          conversation: { channel, accountId: "default", conversationId: "room-1" },
          targetSessionKey: "agent:main:shared",
          targetKind: "session",
        }),
      );
    }
    const first = expectDefined(bindings[0], "first binding");
    const second = expectDefined(bindings[1], "second binding");
    expect(first.bindingId).toBe(second.bindingId);
    expect(service.listBySession(first.targetSessionKey)).toEqual(bindings);

    const scope = { channel: " CHANNEL-A ", accountId: " DEFAULT " };
    service.touch(first.bindingId, 1234, scope);
    expect(service.resolveByConversation(first.conversation)?.metadata?.lastActivityAt).toBe(1234);
    expect(service.resolveByConversation(second.conversation)).toEqual(second);
    await expect(
      service.unbind({ bindingId: first.bindingId, scope, reason: "manual" }),
    ).resolves.toHaveLength(1);
    expect(service.resolveByConversation(first.conversation)).toBeNull();
    expect(service.resolveByConversation(second.conversation)).toEqual(second);

    await service.unbind({
      bindingId: second.bindingId,
      scope: { ...scope, accountId: "missing" },
      reason: "manual",
    });
    expect(service.resolveByConversation(second.conversation)).toEqual(second);
    const rebound = await service.bind({
      targetSessionKey: first.targetSessionKey,
      targetKind: first.targetKind,
      conversation: first.conversation,
    });
    expect(rebound.bindingId).toBe(first.bindingId);
    expect(
      await service.unbind({ targetSessionKey: first.targetSessionKey, reason: "session-ended" }),
    ).toEqual([rebound, second]);
    expect(service.listBySession(first.targetSessionKey)).toEqual([]);
  });

  it("honors owner scopes for generic touch, detach, and session cleanup", async () => {
    const service = getSessionBindingService();
    const first = await service.bind({
      targetSessionKey: "agent:main:shared",
      targetKind: "session",
      conversation: { channel: "workspace", accountId: "default", conversationId: "room-1" },
    });
    const second = await service.bind({
      targetSessionKey: first.targetSessionKey,
      targetKind: "session",
      conversation: { channel: "teamchat", accountId: "default", conversationId: "room-1" },
    });
    service.touch(first.bindingId, 1234, second.conversation);
    expect(service.resolveByConversation(first.conversation)).toEqual(first);
    await expect(
      service.unbind({ bindingId: first.bindingId, scope: second.conversation, reason: "manual" }),
    ).resolves.toEqual([]);
    service.touch(first.bindingId, 1234, first.conversation);
    expect(service.resolveByConversation(first.conversation)?.metadata?.lastActivityAt).toBe(1234);
    await expect(
      service.unbind({
        targetSessionKey: first.targetSessionKey,
        scope: first.conversation,
        reason: "session-ended",
      }),
    ).resolves.toHaveLength(1);
    expect(service.resolveByConversation(first.conversation)).toBeNull();
    closeOpenClawStateDatabaseForTest();
    expect(service.resolveByConversation(second.conversation)).toEqual(second);
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
    await expectSessionBindingError(
      getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-1",
        targetKind: "subagent",
        conversation: {
          channel: "demo-binding",
          accountId: "default",
          conversationId: "thread-1",
        },
      }),
      "BINDING_ADAPTER_UNAVAILABLE",
    );
  });

  it.each(["adapter-chat", "legacy-adapter-chat"])(
    "distinguishes an unavailable %s owner from an empty result",
    async (channel) => {
      const service = getSessionBindingService();
      const conversation = {
        channel,
        accountId: "default",
        conversationId: "room-1",
      };

      expect(service.getCapabilities(conversation)).toEqual({
        adapterAvailable: false,
        bindSupported: false,
        unbindSupported: false,
        placements: [],
      });
      const unavailable: ConversationBindingInspection =
        inspectSessionBindingByConversation(conversation);
      expect(unavailable).toEqual({
        status: "unavailable",
      });
      await expectSessionBindingError(
        service.bind({
          targetSessionKey: "agent:finance:bound",
          targetKind: "session",
          conversation,
        }),
        "BINDING_ADAPTER_UNAVAILABLE",
      );
      const adapter: SessionBindingAdapter = {
        channel,
        accountId: "default",
        listBySession: () => [],
        resolveByConversation: () => null,
      };
      registerSessionBindingAdapter(adapter);
      expect(inspectSessionBindingByConversation(conversation)).toEqual({
        status: "available",
        binding: null,
      });
      unregisterSessionBindingAdapter({ channel, accountId: "default", adapter });
      expect(inspectSessionBindingByConversation(conversation)).toEqual({
        status: "unavailable",
      });
    },
  );

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
      .catch((error: unknown) => error);

    expect(isSessionBindingError(rejected)).toBe(true);
    const rejectedRecord = requireRecord(rejected, "session binding error");
    expectRecordFields(rejectedRecord, {
      code: "BINDING_CAPABILITY_UNSUPPORTED",
    });
    expectRecordFields(requireRecord(rejectedRecord.details, "session binding details"), {
      placement: "child",
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

    await expectSessionBindingError(
      getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-1",
        targetKind: "subagent",
        conversation: {
          channel: "demo-binding",
          accountId: "default",
          conversationId: "thread-1",
        },
      }),
      "BINDING_CREATE_FAILED",
    );
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

    expectRecordFields(requireRecord(bound, "bound record"), {
      bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
      targetKind: "session",
      status: "active",
    });
    expectConversationFields(bound.conversation, {
      channel: "workspace",
      accountId: "default",
      conversationId: "user:U123",
    });
    expectRecordFields(requireRecord(bound.metadata, "metadata"), {
      label: "workspace-dm",
    });

    const resolved = service.resolveByConversation({
      channel: "workspace",
      accountId: "default",
      conversationId: "user:U123",
    });
    expectRecordFields(requireRecord(resolved, "resolved binding"), {
      bindingId: bound.bindingId,
      targetSessionKey: "agent:codex:acp:workspace-dm",
    });
    expect(service.listBySession("agent:codex:acp:workspace-dm")).toEqual([resolved]);

    service.touch(bound.bindingId, 1234);
    expectRecordFields(
      requireRecord(
        service.resolveByConversation({
          channel: "workspace",
          accountId: "default",
          conversationId: "user:U123",
        })?.metadata,
        "touched metadata",
      ),
      {
        label: "workspace-dm",
        lastActivityAt: 1234,
      },
    );

    const unbound = await service.unbind({
      targetSessionKey: "agent:codex:acp:workspace-dm",
      reason: "test cleanup",
    });
    expect(unbound).toHaveLength(1);
    expect(unbound[0]?.bindingId).toBe(bound.bindingId);
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

    const rejected = await expectSessionBindingError(
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
      "BINDING_CAPABILITY_UNSUPPORTED",
    );
    expectRecordFields(requireRecord(requireRecord(rejected, "rejected").details, "details"), {
      channel: "teamchat",
      accountId: "default",
      placement: "child",
    });

    const bound = await service.bind({
      targetSessionKey: "agent:codex:acp:teamchat-room",
      targetKind: "session",
      conversation: {
        channel: "teamchat",
        accountId: "default",
        conversationId: "19:chatid@thread.v2",
      },
    });
    expectConversationFields(bound.conversation, {
      channel: "teamchat",
      accountId: "default",
      conversationId: "19:chatid@thread.v2",
    });
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

    expect(getSessionBindingService().listBySession("agent:main")).toStrictEqual([]);
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

    first.testing.resetSessionBindingAdaptersForTests();
    first.registerSessionBindingAdapter(firstAdapter);
    second.registerSessionBindingAdapter(secondAdapter);

    expect(second.testing.getRegisteredAdapterKeys()).toEqual(["demo-binding:default"]);

    const secondBound = await second.getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-1",
      targetKind: "subagent",
      conversation: {
        channel: "demo-binding",
        accountId: "default",
        conversationId: "thread-1",
      },
    });
    expectConversationFields(secondBound.conversation, {
      channel: "demo-binding",
      accountId: "default",
      conversationId: "thread-1",
    });
    expect(firstBind).not.toHaveBeenCalled();
    expect(secondBind).toHaveBeenCalledTimes(1);

    second.unregisterSessionBindingAdapter({
      channel: "demo-binding",
      accountId: "default",
      adapter: secondAdapter,
    });

    const firstBound = await second.getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-2",
      targetKind: "subagent",
      conversation: {
        channel: "demo-binding",
        accountId: "default",
        conversationId: "thread-2",
      },
    });
    expectConversationFields(firstBound.conversation, {
      channel: "demo-binding",
      accountId: "default",
      conversationId: "thread-2",
    });
    expect(firstBind).toHaveBeenCalledTimes(1);
    expect(secondBind).toHaveBeenCalledTimes(1);

    first.unregisterSessionBindingAdapter({
      channel: "demo-binding",
      accountId: "default",
      adapter: firstAdapter,
    });

    await expectSessionBindingError(
      second.getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-3",
        targetKind: "subagent",
        conversation: {
          channel: "demo-binding",
          accountId: "default",
          conversationId: "thread-3",
        },
      }),
      "BINDING_ADAPTER_UNAVAILABLE",
    );

    first.testing.resetSessionBindingAdaptersForTests();
  });
});
