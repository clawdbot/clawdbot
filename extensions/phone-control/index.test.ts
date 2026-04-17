import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import registerPhoneControl from "./index.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "./runtime-api.js";

const PHONE_CONTROL_STATE_PREFIX = "openclaw-phone-control-test-";
const WRITE_COMMANDS = ["calendar.add", "contacts.add", "reminders.add", "sms.send"] as const;

function createApi(params: {
  stateDir: string;
  getConfig: () => Record<string, unknown>;
  writeConfig: (next: Record<string, unknown>) => Promise<void>;
  registerCommand: (command: OpenClawPluginCommandDefinition) => void;
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
      },
      config: {
        loadConfig: () => params.getConfig(),
        writeConfigFile: (next: Record<string, unknown>) => params.writeConfig(next),
      },
    } as OpenClawPluginApi["runtime"],
    registerCommand: params.registerCommand,
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
  it("arms sms.send as part of the writes group", async () => {
    await withRegisteredPhoneControl(async ({ command, writeConfigFile, getConfig }) => {
      expect(command.name).toBe("phone");

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
      expect(nodes.denyCommands).toEqual([]);
      expect(text).toContain("sms.send");
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

  it("allows external channel callers without operator.admin to mutate phone control", async () => {
    await withRegisteredPhoneControl(async ({ command, writeConfigFile }) => {
      const res = await command.handler({
        ...createCommandContext("arm writes 30s"),
        channel: "telegram",
      });

      expect(res?.text ?? "").toContain("Phone control: armed");
      expect(writeConfigFile).toHaveBeenCalledTimes(1);
    });
  });

  it("allows external channel callers without operator.admin to disarm phone control", async () => {
    await withRegisteredPhoneControl(async ({ command, writeConfigFile }) => {
      const res = await command.handler({
        ...createCommandContext("disarm"),
        channel: "telegram",
      });

      expect(res?.text ?? "").toContain("Phone control: disarmed.");
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
});
