import {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type ThreadBindingRecord = {
  accountId: string;
  threadId: string;
};

type MockResolvedDiscordAccount = {
  accountId: string;
  config: {
    threadBindings?: {
      enabled?: boolean;
      spawnSessions?: boolean;
    };
  };
};

type MockResolveDiscordAccountParams = {
  cfg?: {
    channels?: {
      discord?: {
        defaultAccount?: string;
        accounts?: Record<
          string,
          { threadBindings?: MockResolvedDiscordAccount["config"]["threadBindings"] }
        >;
      };
    };
  };
  accountId?: string;
};

const hookMocks = vi.hoisted(() => {
  const resolveDiscordAccountImpl = (
    params?: MockResolveDiscordAccountParams,
  ): MockResolvedDiscordAccount => {
    const accountId =
      params?.accountId?.trim() || params?.cfg?.channels?.discord?.defaultAccount || "default";
    return {
      accountId,
      config: {
        threadBindings: params?.cfg?.channels?.discord?.accounts?.[accountId]?.threadBindings ?? {
          spawnSessions: true,
        },
      },
    };
  };
  return {
    resolveDiscordAccountImpl,
    resolveDiscordAccount: vi.fn(resolveDiscordAccountImpl),
    autoBindSpawnedDiscordSubagent: vi.fn(
      async (): Promise<{ threadId: string } | null> => ({ threadId: "thread-1" }),
    ),
    listThreadBindingsBySessionKey: vi.fn((_params?: unknown): ThreadBindingRecord[] => []),
    unbindThreadBindingsBySessionKey: vi.fn(() => []),
  };
});

let registerDiscordSubagentHooks: typeof import("../subagent-hooks-api.js").registerDiscordSubagentHooks;

vi.mock("./accounts.js", () => ({
  resolveDiscordAccount: hookMocks.resolveDiscordAccount,
}));
vi.mock("./monitor/thread-bindings.js", () => ({
  autoBindSpawnedDiscordSubagent: hookMocks.autoBindSpawnedDiscordSubagent,
  listThreadBindingsBySessionKey: hookMocks.listThreadBindingsBySessionKey,
  unbindThreadBindingsBySessionKey: hookMocks.unbindThreadBindingsBySessionKey,
}));

function registerHandlersForTest(
  config: Record<string, unknown> = {
    channels: {
      discord: {
        threadBindings: {
          spawnSessions: true,
        },
      },
    },
  },
) {
  return registerHookHandlersForTest<OpenClawPluginApi>({
    config,
    register: registerDiscordSubagentHooks,
  });
}

async function resolveSubagentDeliveryTargetForTest(requesterOrigin: {
  channel: string;
  accountId: string;
  to: string;
  threadId?: string;
}) {
  const handlers = registerHandlersForTest();
  const handler = getRequiredHookHandler(handlers, "subagent_delivery_target");
  return await handler(
    {
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterOrigin,
      childRunId: "run-1",
      spawnMode: "session",
      expectsCompletionMessage: true,
    },
    {},
  );
}

function createSpawnEvent(overrides?: {
  childSessionKey?: string;
  agentId?: string;
  label?: string;
  mode?: string;
  requester?: {
    channel?: string;
    accountId?: string | undefined;
    to?: string;
    threadId?: string;
  };
  threadRequested?: boolean;
}): {
  childSessionKey: string;
  agentId: string;
  label: string;
  mode: string;
  requester: {
    channel: string;
    accountId?: string;
    to: string;
    threadId?: string;
  };
  threadRequested: boolean;
} {
  const base = {
    childSessionKey: "agent:main:subagent:child",
    agentId: "main",
    label: "banana",
    mode: "session",
    requester: {
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      threadId: "456",
    },
    threadRequested: true,
  };
  return {
    ...base,
    ...overrides,
    requester: {
      ...base.requester,
      ...overrides?.requester,
    },
  };
}

function createSpawnEventWithoutThread() {
  return createSpawnEvent({
    label: "",
    requester: { threadId: undefined },
  });
}

async function runSubagentSpawning(
  config?: Record<string, unknown>,
  event = createSpawnEventWithoutThread(),
) {
  const handlers = registerHandlersForTest(config);
  const handler = getRequiredHookHandler(handlers, "subagent_spawning");
  return await handler(event, {});
}

async function expectSubagentSpawningError(params?: {
  config?: Record<string, unknown>;
  errorContains?: string;
  event?: ReturnType<typeof createSpawnEvent>;
}) {
  const result = await runSubagentSpawning(params?.config, params?.event);
  expect(hookMocks.autoBindSpawnedDiscordSubagent).not.toHaveBeenCalled();
  expect(result).toMatchObject({ status: "error" });
  if (params?.errorContains) {
    const errorText = (result as { error?: string }).error ?? "";
    expect(errorText).toContain(params.errorContains);
  }
}

describe("discord subagent hook handlers", () => {
  beforeAll(async () => {
    ({ registerDiscordSubagentHooks } = await import("../subagent-hooks-api.js"));
  });

  beforeEach(() => {
    hookMocks.resolveDiscordAccount.mockClear();
    hookMocks.resolveDiscordAccount.mockImplementation(hookMocks.resolveDiscordAccountImpl);
    hookMocks.autoBindSpawnedDiscordSubagent.mockClear();
    hookMocks.listThreadBindingsBySessionKey.mockClear();
    hookMocks.unbindThreadBindingsBySessionKey.mockClear();
  });

  it("binds thread routing on subagent_spawning", async () => {
    const handlers = registerHandlersForTest();
    const handler = getRequiredHookHandler(handlers, "subagent_spawning");

    const result = await handler(createSpawnEvent(), {});

    expect(hookMocks.autoBindSpawnedDiscordSubagent).toHaveBeenCalledTimes(1);
    expect(hookMocks.autoBindSpawnedDiscordSubagent).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        channels: expect.objectContaining({
          discord: expect.objectContaining({
            threadBindings: expect.objectContaining({
              spawnSessions: true,
            }),
          }),
        }),
      }),
      accountId: "work",
      channel: "discord",
      to: "channel:123",
      threadId: "456",
      childSessionKey: "agent:main:subagent:child",
      agentId: "main",
      label: "banana",
      boundBy: "system",
    });
    expect(result).toMatchObject({ status: "ok", threadBindingReady: true });
  });

  it("returns error when thread-bound subagent spawn is disabled", async () => {
    await expectSubagentSpawningError({
      config: {
        channels: {
          discord: {
            threadBindings: {
              spawnSessions: false,
            },
          },
        },
      },
      errorContains: "spawnSessions=true",
    });
  });

  it("honors defaultAccount policy when requester omits accountId", async () => {
    await expectSubagentSpawningError({
      config: {
        channels: {
          discord: {
            defaultAccount: "work",
            threadBindings: {
              spawnSessions: true,
            },
            accounts: {
              work: {
                threadBindings: {
                  spawnSessions: false,
                },
              },
            },
          },
        },
      },
      event: createSpawnEvent({
        requester: {
          accountId: undefined,
          channel: "discord",
          to: "channel:123",
          threadId: undefined,
        },
      }),
      errorContains: "spawnSessions=true",
    });
    expect(hookMocks.resolveDiscordAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: undefined,
      }),
    );
  });

  it("returns error when global thread bindings are disabled", async () => {
    await expectSubagentSpawningError({
      config: {
        session: {
          threadBindings: {
            enabled: false,
          },
        },
        channels: {
          discord: {
            threadBindings: {
              spawnSessions: true,
            },
          },
        },
      },
      errorContains: "threadBindings.enabled=true",
    });
  });

  it("allows account-level threadBindings.enabled to override global disable", async () => {
    const result = await runSubagentSpawning({
      session: {
        threadBindings: {
          enabled: false,
        },
      },
      channels: {
        discord: {
          accounts: {
            work: {
              threadBindings: {
                enabled: true,
                spawnSessions: true,
              },
            },
          },
        },
      },
    });

    expect(hookMocks.autoBindSpawnedDiscordSubagent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "ok", threadBindingReady: true });
  });

  it("defaults thread-bound subagent spawn to enabled when unset", async () => {
    const result = await runSubagentSpawning({
      channels: {
        discord: {
          threadBindings: {},
        },
      },
    });

    expect(hookMocks.autoBindSpawnedDiscordSubagent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "ok", threadBindingReady: true });
  });

  it("no-ops when thread binding is requested on non-discord channel", async () => {
    const result = await runSubagentSpawning(
      undefined,
      createSpawnEvent({
        requester: {
          channel: "signal",
          accountId: "",
          to: "+123",
          threadId: undefined,
        },
      }),
    );

    expect(hookMocks.autoBindSpawnedDiscordSubagent).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("returns error when thread bind fails", async () => {
    hookMocks.autoBindSpawnedDiscordSubagent.mockResolvedValueOnce(null);
    const result = await runSubagentSpawning();

    expect(result).toMatchObject({ status: "error" });
    const errorText = (result as { error?: string }).error ?? "";
    expect(errorText).toMatch(/unable to create or bind/i);
  });

  it("unbinds thread routing on subagent_ended", async () => {
    const handlers = registerHandlersForTest();
    const handler = getRequiredHookHandler(handlers, "subagent_ended");

    await handler(
      {
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent",
        reason: "subagent-complete",
        sendFarewell: true,
        accountId: "work",
      },
      {},
    );

    expect(hookMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(hookMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "work",
      targetKind: "subagent",
      reason: "subagent-complete",
      sendFarewell: true,
    });
  });

  it("resolves delivery target from matching bound thread", async () => {
    hookMocks.listThreadBindingsBySessionKey.mockReturnValueOnce([
      { accountId: "work", threadId: "777" },
    ]);
    const result = await resolveSubagentDeliveryTargetForTest({
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      threadId: "777",
    });

    expect(hookMocks.listThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "work",
      targetKind: "subagent",
    });
    expect(result).toEqual({
      origin: {
        channel: "discord",
        accountId: "work",
        to: "channel:777",
        threadId: "777",
      },
    });
  });

  it("keeps original routing when delivery target is ambiguous", async () => {
    hookMocks.listThreadBindingsBySessionKey.mockReturnValueOnce([
      { accountId: "work", threadId: "777" },
      { accountId: "work", threadId: "888" },
    ]);
    const result = await resolveSubagentDeliveryTargetForTest({
      channel: "discord",
      accountId: "work",
      to: "channel:123",
    });

    expect(result).toBeUndefined();
  });
});
