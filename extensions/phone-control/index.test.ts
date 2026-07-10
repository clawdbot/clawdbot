// Phone Control tests cover index plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import registerPhoneControl from "./index.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  OpenClawPluginService,
  PluginCommandContext,
} from "./runtime-api.js";

type RegisteredNodeInvokePolicy = Parameters<OpenClawPluginApi["registerNodeInvokePolicy"]>[0];
type NodeInvokePolicyContext = Parameters<RegisteredNodeInvokePolicy["handle"]>[0];

const PHONE_CONTROL_STATE_PREFIX = "openclaw-phone-control-test-";
const WRITE_COMMANDS = ["calendar.add", "contacts.add", "reminders.add", "sms.send"] as const;
const FRESH_SETUP_DENY_COMMANDS = [
  "calendar.add",
  "computer.act",
  "contacts.add",
  "reminders.add",
  "sms.send",
] as const;

function createApi(params: {
  stateDir: string;
  getConfig: () => Record<string, unknown>;
  writeConfig: (next: Record<string, unknown>) => Promise<void>;
  registerCommand: (command: OpenClawPluginCommandDefinition) => void;
  registerNodeInvokePolicy?: OpenClawPluginApi["registerNodeInvokePolicy"];
  registerService?: (service: OpenClawPluginService) => void;
  openKeyedStore?: OpenClawPluginApi["runtime"]["state"]["openKeyedStore"];
  beforeMutateConfig?: (draft: Record<string, unknown>) => void | Promise<void>;
}): OpenClawPluginApi {
  return createTestPluginApi({
    id: "phone-control",
    name: "phone-control",
    source: "test",
    config: {},
    pluginConfig: {},
    runtime: {
      state: {
        resolveStateDir: () => params.stateDir,
        openKeyedStore:
          params.openKeyedStore ??
          ((options: OpenKeyedStoreOptions) =>
            createPluginStateKeyedStoreForTests("phone-control", {
              ...options,
              env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
            })),
      },
      config: {
        current: () => params.getConfig(),
        mutateConfigFile: async ({
          mutate,
        }: {
          mutate: (draft: Record<string, unknown>) => void | Promise<void>;
        }) => {
          const nextConfig = structuredClone(params.getConfig());
          await params.beforeMutateConfig?.(nextConfig);
          await mutate(nextConfig);
          await params.writeConfig(nextConfig);
          return {
            path: "/tmp/openclaw.json",
            previousHash: null,
            persistedHash: null,
            snapshot: {},
            nextConfig,
            afterWrite: { mode: "auto" },
            followUp: { mode: "auto", requiresRestart: false },
            result: undefined,
          };
        },
        replaceConfigFile: ({ nextConfig }: { nextConfig: unknown }) =>
          params.writeConfig(nextConfig as Record<string, unknown>),
      },
    } as unknown as OpenClawPluginApi["runtime"],
    registerCommand: params.registerCommand,
    ...(params.registerNodeInvokePolicy
      ? { registerNodeInvokePolicy: params.registerNodeInvokePolicy }
      : {}),
    ...(params.registerService ? { registerService: params.registerService } : {}),
  });
}

function createCommandContext(args: string): PluginCommandContext {
  return {
    channel: "test",
    isAuthorizedSender: true,
    commandBody: `/phone ${args}`,
    args,
    config: {},
    requestConversationBinding: async () => ({
      status: "error",
      message: "unsupported",
    }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
  };
}

function createPhoneControlConfig(): Record<string, unknown> {
  return {
    gateway: {
      nodes: {
        allowCommands: [],
        denyCommands: [...FRESH_SETUP_DENY_COMMANDS],
      },
    },
  };
}

function createMockOpenKeyedStore(params: {
  lookup: (key: string) => Promise<unknown>;
  delete?: (key: string) => Promise<boolean>;
}): OpenClawPluginApi["runtime"]["state"]["openKeyedStore"] {
  return <T>() => {
    const lookup = params.lookup as (key: string) => Promise<T | undefined>;
    const remove = params.delete ?? (async () => true);
    const store: PluginStateKeyedStore<T> = {
      register: async () => {},
      registerIfAbsent: async () => true,
      update: async () => true,
      lookup,
      consume: async (key) => {
        const value = await lookup(key);
        if (value !== undefined) {
          await remove(key);
        }
        return value;
      },
      delete: remove,
      entries: async () => {
        const value = await lookup("current");
        return value === undefined ? [] : [{ key: "current", value, createdAt: 0 }];
      },
      clear: async () => {},
    };
    return store;
  };
}

function createInMemoryArmStore(
  options: {
    onRegister?: (key: string, value: unknown) => void | Promise<void>;
    onUpdate?: (key: string) => void | Promise<void>;
    onEntries?: () => void | Promise<void>;
  } = {},
) {
  const values = new Map<string, unknown>();
  const register = vi.fn(async (key: string, value: unknown) => {
    await options.onRegister?.(key, value);
    values.set(key, structuredClone(value));
  });
  const update = vi.fn(async (key: string, updateValue: (current: unknown) => unknown) => {
    await options.onUpdate?.(key);
    const next = updateValue(values.get(key));
    if (next === undefined) {
      return false;
    }
    values.set(key, structuredClone(next));
    return true;
  });
  const entries = vi.fn(async () => {
    await options.onEntries?.();
    return [...values.entries()].map(([key, value]) => ({ key, value, createdAt: 0 }));
  });
  const consume = vi.fn(async (key: string) => {
    const value = values.get(key);
    if (value === undefined) {
      return undefined;
    }
    values.delete(key);
    return structuredClone(value);
  });
  const openKeyedStore: OpenClawPluginApi["runtime"]["state"]["openKeyedStore"] = <T>() =>
    ({
      register,
      registerIfAbsent: vi.fn(async () => true),
      update,
      lookup: vi.fn(async (key: string) => structuredClone(values.get(key)) as T | undefined),
      consume,
      delete: vi.fn(async (key: string) => values.delete(key)),
      entries,
      clear: vi.fn(async () => values.clear()),
    }) as unknown as PluginStateKeyedStore<T>;
  return { values, register, update, entries, consume, openKeyedStore };
}

function createPolicyContext(
  config: Record<string, unknown>,
  params: Record<string, unknown> = { action: "left_click", x: 10, y: 20 },
  command = "computer.act",
  invoke: NodeInvokePolicyContext["invokeNode"] = async () => ({
    ok: true,
    payload: { accepted: true },
  }),
) {
  const invokeNode = vi.fn<NodeInvokePolicyContext["invokeNode"]>(invoke);
  const ctx = {
    nodeId: "node-1",
    command,
    params,
    config: config as NodeInvokePolicyContext["config"],
    client: null,
    invokeNode,
  } satisfies NodeInvokePolicyContext;
  return { ctx, invokeNode };
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function withRegisteredPhoneControl(
  run: (params: {
    command: OpenClawPluginCommandDefinition;
    policy: RegisteredNodeInvokePolicy;
    service: OpenClawPluginService;
    writeConfigFile: ReturnType<typeof vi.fn>;
    getConfig: () => Record<string, unknown>;
    stateDir: string;
  }) => Promise<void>,
  options: {
    initialConfig?: Record<string, unknown>;
    openKeyedStore?: OpenClawPluginApi["runtime"]["state"]["openKeyedStore"];
    beforeWriteConfig?: (next: Record<string, unknown>) => Promise<void>;
    beforeMutateConfig?: (draft: Record<string, unknown>) => void | Promise<void>;
  } = {},
) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), PHONE_CONTROL_STATE_PREFIX));
  try {
    let config = structuredClone(options.initialConfig ?? createPhoneControlConfig());
    const writeConfigFile = vi.fn(async (next: Record<string, unknown>) => {
      await options.beforeWriteConfig?.(next);
      config = next;
    });

    let command: OpenClawPluginCommandDefinition | undefined;
    let policy: RegisteredNodeInvokePolicy | undefined;
    let service: OpenClawPluginService | undefined;
    registerPhoneControl.register(
      createApi({
        stateDir,
        getConfig: () => config,
        writeConfig: writeConfigFile,
        registerCommand: (nextCommand) => {
          command = nextCommand;
        },
        registerNodeInvokePolicy: (nextPolicy) => {
          policy = nextPolicy;
        },
        registerService: (nextService) => {
          service = nextService;
        },
        ...(options.beforeMutateConfig ? { beforeMutateConfig: options.beforeMutateConfig } : {}),
        ...(options.openKeyedStore ? { openKeyedStore: options.openKeyedStore } : {}),
      }),
    );

    if (!command) {
      throw new Error("phone-control plugin did not register its command");
    }
    if (!policy) {
      throw new Error("phone-control plugin did not register its node invoke policy");
    }
    if (!service) {
      throw new Error("phone-control plugin did not register its expiry service");
    }

    await run({
      command,
      policy,
      service,
      writeConfigFile,
      getConfig: () => config,
      stateDir,
    });
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("phone-control plugin", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
  });

  it("arms sms.send as part of the writes group", async () => {
    await withRegisteredPhoneControl(async ({ command, writeConfigFile, getConfig }) => {
      expect(command.name).toBe("phone");
      expect(command.requiredScopes).toBeUndefined();
      expect(command.exposeSenderIsOwner).toBe(true);

      const res = await command.handler({
        ...createCommandContext("arm writes 30s"),
        channel: "webchat",
        gatewayClientScopes: ["operator.admin"],
      });
      const text = res?.text ?? "";
      const nodes = (
        getConfig().gateway as { nodes?: { allowCommands?: string[]; denyCommands?: string[] } }
      ).nodes;
      if (!nodes) {
        throw new Error("phone-control command did not persist gateway node config");
      }

      expect(writeConfigFile).toHaveBeenCalledTimes(1);
      expect(nodes.allowCommands).toEqual([...WRITE_COMMANDS]);
      expect(nodes.denyCommands).toStrictEqual(["computer.act"]);
      expect(text).toContain("sms.send");
    });
  });

  it("arms computer.act as the computer group", async () => {
    await withRegisteredPhoneControl(async ({ command, policy, writeConfigFile, getConfig }) => {
      expect(policy.commands).toStrictEqual(["computer.act"]);
      const res = await command.handler({
        ...createCommandContext("arm computer 30s"),
        channel: "webchat",
        gatewayClientScopes: ["operator.admin"],
      });
      const text = res?.text ?? "";
      const nodes = (
        getConfig().gateway as { nodes?: { allowCommands?: string[]; denyCommands?: string[] } }
      ).nodes;
      if (!nodes) {
        throw new Error("phone-control command did not persist gateway node config");
      }

      expect(writeConfigFile).toHaveBeenCalledTimes(1);
      expect(nodes.allowCommands).toEqual(["computer.act"]);
      // Arming removes the fresh-setup computer deny while leaving the writes
      // group denied.
      expect(nodes.denyCommands).toStrictEqual([...WRITE_COMMANDS]);
      expect(text).toContain("computer.act");
    });
  });

  it("persists the preparing lease before widening computer config", async () => {
    const store = createInMemoryArmStore({
      onRegister: () => {
        throw new Error("state write unavailable");
      },
    });
    await withRegisteredPhoneControl(
      async ({ command, writeConfigFile, getConfig }) => {
        await expect(
          command.handler({
            ...createCommandContext("arm computer 30s"),
            channel: "webchat",
            gatewayClientScopes: ["operator.admin"],
          }),
        ).rejects.toThrow("failed to persist temporary arm lease");

        const nodes = (
          getConfig().gateway as { nodes?: { allowCommands?: string[]; denyCommands?: string[] } }
        ).nodes;
        expect(writeConfigFile).not.toHaveBeenCalled();
        expect(nodes?.allowCommands).not.toContain("computer.act");
        expect(nodes?.denyCommands).toContain("computer.act");
      },
      { openKeyedStore: store.openKeyedStore },
    );
  });

  it("rolls back a preparing lease when the config commit fails", async () => {
    const store = createInMemoryArmStore();
    let failNextWrite = true;
    await withRegisteredPhoneControl(
      async ({ command, writeConfigFile, getConfig }) => {
        await expect(
          command.handler({
            ...createCommandContext("arm computer 30s"),
            channel: "webchat",
            gatewayClientScopes: ["operator.admin"],
          }),
        ).rejects.toThrow("failed to persist temporary arm lease");

        const nodes = (
          getConfig().gateway as { nodes?: { allowCommands?: string[]; denyCommands?: string[] } }
        ).nodes;
        expect(writeConfigFile).toHaveBeenCalledTimes(2);
        expect(store.values.size).toBe(0);
        expect(nodes?.allowCommands).not.toContain("computer.act");
        expect(nodes?.denyCommands).toContain("computer.act");
      },
      {
        openKeyedStore: store.openKeyedStore,
        beforeWriteConfig: async () => {
          if (failNextWrite) {
            failNextWrite = false;
            throw new Error("config commit failed");
          }
        },
      },
    );
  });

  it("rolls back committed config from the local journal when activation loses state", async () => {
    const store = createInMemoryArmStore({
      onUpdate: () => {
        store.values.clear();
      },
    });
    await withRegisteredPhoneControl(
      async ({ command, writeConfigFile, getConfig }) => {
        await expect(
          command.handler({
            ...createCommandContext("arm computer 30s"),
            channel: "webchat",
            gatewayClientScopes: ["operator.admin"],
          }),
        ).rejects.toThrow("failed to persist temporary arm lease");

        const nodes = (
          getConfig().gateway as { nodes?: { allowCommands?: string[]; denyCommands?: string[] } }
        ).nodes;
        expect(writeConfigFile).toHaveBeenCalledTimes(2);
        expect(store.values.size).toBe(0);
        expect(nodes?.allowCommands).not.toContain("computer.act");
        expect(nodes?.denyCommands).toContain("computer.act");
      },
      { openKeyedStore: store.openKeyedStore },
    );
  });

  it("derives arm lists from the transaction draft and preserves a concurrent operator edit", async () => {
    let injectOperatorEdit = true;
    await withRegisteredPhoneControl(
      async ({ command, getConfig }) => {
        await command.handler({
          ...createCommandContext("arm computer 30s"),
          channel: "webchat",
          gatewayClientScopes: ["operator.admin"],
        });

        const nodes = (
          getConfig().gateway as { nodes?: { allowCommands?: string[]; denyCommands?: string[] } }
        ).nodes;
        expect(nodes?.allowCommands).toStrictEqual(["computer.act", "operator.keep"]);
        expect(nodes?.denyCommands).toStrictEqual([...WRITE_COMMANDS, "operator.block"].toSorted());
      },
      {
        beforeMutateConfig: (draft) => {
          if (!injectOperatorEdit) {
            return;
          }
          injectOperatorEdit = false;
          const nodes = (
            draft.gateway as {
              nodes: { allowCommands: string[]; denyCommands: string[] };
            }
          ).nodes;
          nodes.allowCommands.push("operator.keep");
          nodes.denyCommands.push("operator.block");
        },
      },
    );
  });

  it("passes a valid active computer lease through the node policy", async () => {
    await withRegisteredPhoneControl(async ({ command, policy, getConfig }) => {
      await command.handler({
        ...createCommandContext("arm computer 30s"),
        channel: "webchat",
        gatewayClientScopes: ["operator.admin"],
      });
      const { ctx, invokeNode } = createPolicyContext(getConfig());

      await expect(policy.handle(ctx)).resolves.toMatchObject({ ok: true });
      expect(invokeNode).toHaveBeenCalledOnce();
    });
  });

  it("does not let unresolved computer transport block manual disarm", async () => {
    const transportStarted = createDeferred();
    const releaseTransport = createDeferred();
    await withRegisteredPhoneControl(async ({ command, policy, getConfig }) => {
      await command.handler({
        ...createCommandContext("arm computer 30s"),
        channel: "webchat",
        gatewayClientScopes: ["operator.admin"],
      });
      const { ctx } = createPolicyContext(
        getConfig(),
        { action: "left_click", x: 10, y: 20 },
        "computer.act",
        async () => {
          transportStarted.resolve();
          await releaseTransport.promise;
          return { ok: true, payload: { accepted: true } };
        },
      );
      const dispatch = policy.handle(ctx);
      await transportStarted.promise;

      try {
        await expect(
          command.handler({
            ...createCommandContext("disarm"),
            channel: "webchat",
            gatewayClientScopes: ["operator.admin"],
          }),
        ).resolves.toMatchObject({ text: expect.stringContaining("disarmed") });
        const nodes = (
          getConfig().gateway as { nodes?: { allowCommands?: string[]; denyCommands?: string[] } }
        ).nodes;
        expect(nodes?.allowCommands).not.toContain("computer.act");
        expect(nodes?.denyCommands).toContain("computer.act");
      } finally {
        releaseTransport.resolve();
      }
      await expect(dispatch).resolves.toMatchObject({ ok: true });
    });
  });

  it("passes an operator-authored persistent computer grant without a lease", async () => {
    const initialConfig = {
      gateway: {
        nodes: {
          allowCommands: ["computer.act"],
          denyCommands: [...WRITE_COMMANDS],
        },
      },
    };
    await withRegisteredPhoneControl(
      async ({ policy, getConfig }) => {
        const { ctx, invokeNode } = createPolicyContext(getConfig());

        await expect(policy.handle(ctx)).resolves.toMatchObject({ ok: true });
        expect(invokeNode).toHaveBeenCalledOnce();
      },
      { initialConfig },
    );
  });

  it("denies and cleans an expired computer lease before dispatch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00Z"));
    try {
      await withRegisteredPhoneControl(async ({ command, policy, getConfig }) => {
        await command.handler({
          ...createCommandContext("arm computer 1s"),
          channel: "webchat",
          gatewayClientScopes: ["operator.admin"],
        });
        vi.advanceTimersByTime(1000);
        const { ctx, invokeNode } = createPolicyContext(getConfig());

        await expect(policy.handle(ctx)).resolves.toMatchObject({
          ok: false,
          code: "PHONE_CONTROL_DISARMED",
        });
        expect(invokeNode).not.toHaveBeenCalled();
        const nodes = (
          getConfig().gateway as { nodes?: { allowCommands?: string[]; denyCommands?: string[] } }
        ).nodes;
        expect(nodes?.allowCommands).not.toContain("computer.act");
        expect(nodes?.denyCommands).toContain("computer.act");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("denies and reconciles a preparing computer lease before dispatch", async () => {
    const store = createInMemoryArmStore();
    const generation = "preparing-computer-lease";
    store.values.set(generation, {
      version: 3,
      generation,
      phase: "preparing",
      armedAtMs: Date.now(),
      expiresAtMs: Date.now() + 30_000,
      group: "computer",
      armedCommands: ["computer.act"],
      addedToAllow: ["computer.act"],
      removedFromDeny: ["computer.act"],
      persistentAllows: [],
    });
    const initialConfig = {
      gateway: {
        nodes: {
          allowCommands: ["computer.act"],
          denyCommands: [...WRITE_COMMANDS],
        },
      },
    };
    await withRegisteredPhoneControl(
      async ({ policy, getConfig }) => {
        const { ctx, invokeNode } = createPolicyContext(getConfig());

        await expect(policy.handle(ctx)).resolves.toMatchObject({
          ok: false,
          code: "PHONE_CONTROL_DISARMED",
        });
        expect(invokeNode).not.toHaveBeenCalled();
        expect(store.values.size).toBe(0);
      },
      { initialConfig, openKeyedStore: store.openKeyedStore },
    );
  });

  it("keeps computer dispatch fail-closed when startup cannot read lease state", async () => {
    const store = createInMemoryArmStore({
      onEntries: () => {
        throw new Error("state read unavailable");
      },
    });
    const initialConfig = {
      gateway: {
        nodes: {
          allowCommands: ["computer.act"],
          denyCommands: [...WRITE_COMMANDS],
        },
      },
    };
    await withRegisteredPhoneControl(
      async ({ policy, service, getConfig, stateDir }) => {
        await service.start({
          config: getConfig(),
          stateDir,
          logger: { info() {}, warn() {}, error() {}, debug() {} },
        });
        const { ctx, invokeNode } = createPolicyContext(getConfig());

        await expect(policy.handle(ctx)).resolves.toMatchObject({
          ok: false,
          code: "PHONE_CONTROL_STATE_UNAVAILABLE",
          unavailable: true,
        });
        expect(invokeNode).not.toHaveBeenCalled();
        await service.stop?.({
          config: getConfig(),
          stateDir,
          logger: { info() {}, warn() {}, error() {}, debug() {} },
        });
      },
      { initialConfig, openKeyedStore: store.openKeyedStore },
    );
  });

  it("closes lease admission before draining the old plugin instance", async () => {
    const readStarted = createDeferred();
    const releaseRead = createDeferred();
    let blockNextRead = false;
    const store = createInMemoryArmStore({
      onEntries: async () => {
        if (!blockNextRead) {
          return;
        }
        blockNextRead = false;
        readStarted.resolve();
        await releaseRead.promise;
      },
    });
    await withRegisteredPhoneControl(
      async ({ command, policy, service, writeConfigFile, getConfig, stateDir }) => {
        const serviceContext = {
          config: getConfig(),
          stateDir,
          logger: { info() {}, warn() {}, error() {}, debug() {} },
        };
        await service.start(serviceContext);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });

        blockNextRead = true;
        const inFlightStatus = command.handler({
          ...createCommandContext("status"),
          channel: "webchat",
        });
        await readStarted.promise;

        const stopping = service.stop?.(serviceContext);
        const { ctx, invokeNode } = createPolicyContext(getConfig());
        const latePolicy = expect(policy.handle(ctx)).resolves.toMatchObject({
          ok: false,
          code: "PHONE_CONTROL_STATE_UNAVAILABLE",
          unavailable: true,
        });
        const lateArm = expect(
          command.handler({
            ...createCommandContext("arm computer 30s"),
            channel: "webchat",
            gatewayClientScopes: ["operator.admin"],
          }),
        ).rejects.toThrow("lease owner is stopping");

        releaseRead.resolve();
        await expect(inFlightStatus).resolves.toMatchObject({
          text: expect.stringContaining("disarmed"),
        });
        await stopping;
        await Promise.all([latePolicy, lateArm]);
        expect(invokeNode).not.toHaveBeenCalled();
        expect(writeConfigFile).not.toHaveBeenCalled();
      },
      { openKeyedStore: store.openKeyedStore },
    );
  });

  it("serializes expired cleanup ahead of a concurrent computer rearm", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00Z"));
    const readStarted = createDeferred();
    const releaseRead = createDeferred();
    let blockNextRead = false;
    const store = createInMemoryArmStore({
      onEntries: async () => {
        if (!blockNextRead) {
          return;
        }
        blockNextRead = false;
        readStarted.resolve();
        await releaseRead.promise;
      },
    });
    try {
      await withRegisteredPhoneControl(
        async ({ command, policy, getConfig }) => {
          await command.handler({
            ...createCommandContext("arm computer 1s"),
            channel: "webchat",
            gatewayClientScopes: ["operator.admin"],
          });
          vi.advanceTimersByTime(1000);
          blockNextRead = true;
          const { ctx, invokeNode } = createPolicyContext(getConfig());
          const expiredDispatch = policy.handle(ctx);
          await readStarted.promise;
          const rearm = command.handler({
            ...createCommandContext("arm computer 30s"),
            channel: "webchat",
            gatewayClientScopes: ["operator.admin"],
          });
          releaseRead.resolve();

          await expect(expiredDispatch).resolves.toMatchObject({ ok: false });
          expect(invokeNode).not.toHaveBeenCalled();
          await expect(rearm).resolves.toMatchObject({ text: expect.stringContaining("armed") });
          const finalStatus = await command.handler({
            ...createCommandContext("status"),
            channel: "webchat",
          });
          expect(finalStatus?.text ?? "").toContain("expires in 30s");
          const nodes = (
            getConfig().gateway as { nodes?: { allowCommands?: string[]; denyCommands?: string[] } }
          ).nodes;
          expect(nodes?.allowCommands).toContain("computer.act");
          expect(nodes?.denyCommands).not.toContain("computer.act");
        },
        { openKeyedStore: store.openKeyedStore },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the fresh-setup computer deny when disarmed", async () => {
    await withRegisteredPhoneControl(async ({ command, writeConfigFile, getConfig }) => {
      await command.handler({
        ...createCommandContext("arm computer 30s"),
        channel: "webchat",
        gatewayClientScopes: ["operator.admin"],
      });
      await command.handler({
        ...createCommandContext("disarm"),
        channel: "webchat",
        gatewayClientScopes: ["operator.admin"],
      });

      const nodes = (
        getConfig().gateway as { nodes?: { allowCommands?: string[]; denyCommands?: string[] } }
      ).nodes;
      expect(writeConfigFile).toHaveBeenCalledTimes(2);
      expect(nodes?.allowCommands).toStrictEqual([]);
      expect(nodes?.denyCommands).toStrictEqual([...FRESH_SETUP_DENY_COMMANDS]);
    });
  });

  it("keeps legacy all from arming computer control", async () => {
    await withRegisteredPhoneControl(async ({ command, getConfig }) => {
      const res = await command.handler({
        ...createCommandContext("arm all 30s"),
        channel: "webchat",
        gatewayClientScopes: ["operator.admin"],
      });
      const nodes = (
        getConfig().gateway as { nodes?: { allowCommands?: string[]; denyCommands?: string[] } }
      ).nodes;

      expect(nodes?.allowCommands).not.toContain("computer.act");
      expect(nodes?.denyCommands).toContain("computer.act");
      expect(res?.text ?? "").not.toContain("computer.act");
    });
  });

  it("reports but preserves an operator-authored persistent computer allow", async () => {
    const initialConfig = {
      gateway: {
        nodes: {
          allowCommands: ["computer.act"],
          denyCommands: [...WRITE_COMMANDS],
        },
      },
    };
    await withRegisteredPhoneControl(
      async ({ command, writeConfigFile, getConfig }) => {
        const initialStatus = await command.handler({
          ...createCommandContext("status"),
          channel: "webchat",
        });
        expect(initialStatus?.text ?? "").toContain("remain active after /phone disarm");
        expect(initialStatus?.text ?? "").toContain("computer.act");

        await command.handler({
          ...createCommandContext("arm computer 30s"),
          channel: "webchat",
          gatewayClientScopes: ["operator.admin"],
        });
        const armedStatus = await command.handler({
          ...createCommandContext("status"),
          channel: "webchat",
        });
        expect(armedStatus?.text ?? "").toContain("Arm scope: computer.act");
        expect(armedStatus?.text ?? "").toContain("remain active after /phone disarm");

        const disarm = await command.handler({
          ...createCommandContext("disarm"),
          channel: "webchat",
          gatewayClientScopes: ["operator.admin"],
        });
        const nodes = (
          getConfig().gateway as { nodes?: { allowCommands?: string[]; denyCommands?: string[] } }
        ).nodes;
        expect(disarm?.text ?? "").toContain("remain active after /phone disarm");
        expect(disarm?.text ?? "").toContain("computer.act");
        expect(writeConfigFile).toHaveBeenCalledTimes(1);
        expect(nodes?.allowCommands).toStrictEqual(["computer.act"]);
        expect(nodes?.denyCommands).toStrictEqual([...WRITE_COMMANDS]);
      },
      { initialConfig },
    );
  });

  it("does not leak the allowlist insertion when re-armed then disarmed", async () => {
    await withRegisteredPhoneControl(async ({ command, getConfig }) => {
      const armCtx = () => ({
        ...createCommandContext("arm computer 30s"),
        channel: "webchat" as const,
        gatewayClientScopes: ["operator.admin"],
      });
      await command.handler(armCtx());
      // Re-arm the same group; the single-slot state is replaced.
      await command.handler(armCtx());
      await command.handler({
        ...createCommandContext("disarm"),
        channel: "webchat",
        gatewayClientScopes: ["operator.admin"],
      });
      const nodes = (getConfig().gateway as { nodes?: { allowCommands?: string[] } }).nodes;
      // Disarm must fully remove computer.act despite the re-arm.
      expect(nodes?.allowCommands ?? []).not.toContain("computer.act");
    });
  });

  it("blocks internal operator.write callers from mutating phone control", async () => {
    await withRegisteredPhoneControl(async ({ command, writeConfigFile }) => {
      const res = await command.handler({
        ...createCommandContext("arm writes 30s"),
        channel: "webchat",
        gatewayClientScopes: ["operator.write"],
      });

      expect(res?.text ?? "").toContain("requires operator.admin");
      expect(writeConfigFile).not.toHaveBeenCalled();
    });
  });

  it("blocks external non-owner callers without operator.admin from mutating phone control", async () => {
    await withRegisteredPhoneControl(async ({ command, writeConfigFile }) => {
      const res = await command.handler({
        ...createCommandContext("arm writes 30s"),
        channel: "telegram",
        senderIsOwner: false,
      });

      expect(res?.text ?? "").toContain("requires operator.admin");
      expect(writeConfigFile).not.toHaveBeenCalled();
    });
  });

  it("blocks external non-owner callers without operator.admin from disarming phone control", async () => {
    await withRegisteredPhoneControl(async ({ command, writeConfigFile }) => {
      const res = await command.handler({
        ...createCommandContext("disarm"),
        channel: "telegram",
        senderIsOwner: false,
      });

      expect(res?.text ?? "").toContain("requires operator.admin");
      expect(writeConfigFile).not.toHaveBeenCalled();
    });
  });

  it("allows external non-owner callers without operator.admin to read phone control status", async () => {
    await withRegisteredPhoneControl(async ({ command, writeConfigFile }) => {
      const res = await command.handler({
        ...createCommandContext("status"),
        channel: "telegram",
        senderIsOwner: false,
      });

      expect(res?.text ?? "").toContain("Phone control: disarmed.");
      expect(writeConfigFile).not.toHaveBeenCalled();
    });
  });

  it("allows external non-owner callers without operator.admin to read phone control help", async () => {
    await withRegisteredPhoneControl(async ({ command, writeConfigFile }) => {
      const res = await command.handler({
        ...createCommandContext("help"),
        channel: "telegram",
        senderIsOwner: false,
      });

      expect(res?.text ?? "").toContain("/phone status");
      expect(res?.text ?? "").toContain("explicit /phone arm computer");
      expect(writeConfigFile).not.toHaveBeenCalled();
    });
  });

  it("regression: blocks non-webchat gateway callers with operator.write from arm/disarm", async () => {
    await withRegisteredPhoneControl(async ({ command, writeConfigFile }) => {
      const armRes = await command.handler({
        ...createCommandContext("arm writes 30s"),
        channel: "telegram",
        gatewayClientScopes: ["operator.write"],
      });
      expect(armRes?.text ?? "").toContain("requires operator.admin");
      expect(writeConfigFile).not.toHaveBeenCalled();

      const disarmRes = await command.handler({
        ...createCommandContext("disarm"),
        channel: "telegram",
        gatewayClientScopes: ["operator.write"],
      });
      expect(disarmRes?.text ?? "").toContain("requires operator.admin");
      expect(writeConfigFile).not.toHaveBeenCalled();
    });
  });

  it("allows internal operator.admin callers to mutate phone control", async () => {
    await withRegisteredPhoneControl(async ({ command, writeConfigFile }) => {
      const res = await command.handler({
        ...createCommandContext("arm writes 30s"),
        channel: "webchat",
        gatewayClientScopes: ["operator.admin"],
      });

      expect(res?.text ?? "").toContain("sms.send");
      expect(writeConfigFile).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects invalid arm durations without mutating phone control", async () => {
    await withRegisteredPhoneControl(async ({ command, writeConfigFile }) => {
      const typoRes = await command.handler({
        ...createCommandContext("arm writes forever"),
        channel: "webchat",
        gatewayClientScopes: ["operator.admin"],
      });
      const overflowRes = await command.handler({
        ...createCommandContext("arm writes 9007199254740993d"),
        channel: "webchat",
        gatewayClientScopes: ["operator.admin"],
      });

      expect(typoRes?.text ?? "").toContain("Invalid duration");
      expect(overflowRes?.text ?? "").toContain("Invalid duration");
      expect(writeConfigFile).not.toHaveBeenCalled();
    });
  });

  it("rejects arm requests when the expiry would exceed a valid Date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    try {
      await withRegisteredPhoneControl(async ({ command, writeConfigFile }) => {
        const res = await command.handler({
          ...createCommandContext("arm writes 30s"),
          channel: "webchat",
          gatewayClientScopes: ["operator.admin"],
        });

        expect(res?.text ?? "").toContain("Invalid duration");
        expect(writeConfigFile).not.toHaveBeenCalled();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows external owner callers without gateway scopes to mutate phone control", async () => {
    await withRegisteredPhoneControl(async ({ command, writeConfigFile }) => {
      const res = await command.handler({
        ...createCommandContext("arm writes 30s"),
        channel: "telegram",
        senderIsOwner: true,
      });

      expect(res?.text ?? "").toContain("Phone control: armed");
      expect(writeConfigFile).toHaveBeenCalledTimes(1);
    });
  });

  it("allows external channel callers with operator.admin to disarm phone control", async () => {
    await withRegisteredPhoneControl(async ({ command, writeConfigFile }) => {
      await command.handler({
        ...createCommandContext("arm writes 30s"),
        channel: "webchat",
        gatewayClientScopes: ["operator.admin"],
      });

      const res = await command.handler({
        ...createCommandContext("disarm"),
        channel: "telegram",
        gatewayClientScopes: ["operator.admin"],
      });

      expect(res?.text ?? "").toContain("disarmed");
      expect(writeConfigFile).toHaveBeenCalledTimes(2);
    });
  });

  it("does not block service startup on the initial expiry check", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), PHONE_CONTROL_STATE_PREFIX));
    try {
      const lookup = vi.fn(async () => undefined);
      let service: OpenClawPluginService | undefined;

      registerPhoneControl.register(
        createApi({
          stateDir,
          getConfig: createPhoneControlConfig,
          writeConfig: async () => {},
          registerCommand: () => {},
          registerService: (registeredService) => {
            service = registeredService;
          },
          openKeyedStore: createMockOpenKeyedStore({ lookup }),
        }),
      );

      if (!service) {
        throw new Error("phone-control plugin did not register its service");
      }

      await service.start({
        config: createPhoneControlConfig(),
        stateDir,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      });

      expect(lookup).not.toHaveBeenCalled();

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(lookup).toHaveBeenCalledWith("current");

      await service.stop?.({
        config: createPhoneControlConfig(),
        stateDir,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("clears expired active allows before service startup completes", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), PHONE_CONTROL_STATE_PREFIX));
    try {
      let config: Record<string, unknown> = {
        gateway: {
          nodes: {
            allowCommands: [...WRITE_COMMANDS],
            denyCommands: [],
          },
        },
      };
      const writeConfigFile = vi.fn(async (next: Record<string, unknown>) => {
        config = next;
      });
      const lookup = vi.fn(async () => ({
        version: 2,
        armedAtMs: Date.now() - 120_000,
        expiresAtMs: Date.now() - 60_000,
        group: "writes",
        armedCommands: [...WRITE_COMMANDS],
        addedToAllow: [...WRITE_COMMANDS],
        removedFromDeny: [...WRITE_COMMANDS],
      }));
      const removeState = vi.fn(async () => true);
      let service: OpenClawPluginService | undefined;

      registerPhoneControl.register(
        createApi({
          stateDir,
          getConfig: () => config,
          writeConfig: writeConfigFile,
          registerCommand: () => {},
          registerService: (registeredService) => {
            service = registeredService;
          },
          openKeyedStore: createMockOpenKeyedStore({ lookup, delete: removeState }),
        }),
      );

      if (!service) {
        throw new Error("phone-control plugin did not register its service");
      }

      await service.start({
        config,
        stateDir,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      });

      expect(writeConfigFile).toHaveBeenCalledTimes(1);
      expect(removeState).toHaveBeenCalledWith("current");
      expect(
        (config.gateway as { nodes?: { allowCommands?: string[]; denyCommands?: string[] } }).nodes,
      ).toEqual({
        allowCommands: [],
        denyCommands: [...WRITE_COMMANDS],
      });

      await service.stop?.({
        config,
        stateDir,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
