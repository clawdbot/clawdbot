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

const PHONE_CONTROL_STATE_PREFIX = "openclaw-phone-control-test-";
const WRITE_COMMANDS = ["calendar.add", "contacts.add", "reminders.add", "sms.send"] as const;

function createApi(params: {
  stateDir: string;
  getConfig: () => Record<string, unknown>;
  writeConfig: (next: Record<string, unknown>) => Promise<void>;
  registerCommand: (command: OpenClawPluginCommandDefinition) => void;
  registerService?: (service: OpenClawPluginService) => void;
  openKeyedStore?: OpenClawPluginApi["runtime"]["state"]["openKeyedStore"];
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
          mutate: (draft: Record<string, unknown>) => void;
        }) => {
          const nextConfig = structuredClone(params.getConfig());
          mutate(nextConfig);
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
        denyCommands: [...WRITE_COMMANDS],
      },
    },
  };
}

function createMockOpenKeyedStore(params: {
  lookup: ReturnType<typeof vi.fn>;
  delete?: ReturnType<typeof vi.fn>;
}): OpenClawPluginApi["runtime"]["state"]["openKeyedStore"] {
  return <T>() => {
    const store: PluginStateKeyedStore<T> = {
      register: vi.fn(async () => {}),
      registerIfAbsent: vi.fn(async () => true),
      update: vi.fn(async () => true),
      lookup: params.lookup as (key: string) => Promise<T | undefined>,
      consume: vi.fn(async () => undefined),
      delete: (params.delete ?? vi.fn(async () => true)) as (key: string) => Promise<boolean>,
      entries: vi.fn(async () => []),
      clear: vi.fn(async () => {}),
    };
    return store;
  };
}

async function withRegisteredPhoneControl(
  run: (params: {
    command: OpenClawPluginCommandDefinition;
    writeConfigFile: ReturnType<typeof vi.fn>;
    getConfig: () => Record<string, unknown>;
  }) => Promise<void>,
) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), PHONE_CONTROL_STATE_PREFIX));
  try {
    let config = createPhoneControlConfig();
    const writeConfigFile = vi.fn(async (next: Record<string, unknown>) => {
      config = next;
    });

    let command: OpenClawPluginCommandDefinition | undefined;
    registerPhoneControl.register(
      createApi({
        stateDir,
        getConfig: () => config,
        writeConfig: writeConfigFile,
        registerCommand: (nextCommand) => {
          command = nextCommand;
        },
      }),
    );

    if (!command) {
      throw new Error("phone-control plugin did not register its command");
    }

    await run({
      command,
      writeConfigFile,
      getConfig: () => config,
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
      expect(nodes.denyCommands).toStrictEqual([]);
      expect(text).toContain("sms.send");
    });
  });

  it("arms computer.act as the computer group", async () => {
    await withRegisteredPhoneControl(async ({ command, writeConfigFile, getConfig }) => {
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
      // computer.act was not in the seeded denylist, so the writes-group
      // denies stay untouched when only the computer group is armed.
      expect(nodes.denyCommands).toStrictEqual([...WRITE_COMMANDS]);
      expect(text).toContain("computer.act");
    });
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
