import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const {
  getLoadConfigMock,
  listSkillCommandsForAgents,
  setMyCommandsSpy,
  telegramBotDepsForTest,
  telegramBotRuntimeForTest,
} = await import("./bot.create-telegram-bot.test-harness.js");

let listNativeCommandSpecs: typeof import("../../../src/auto-reply/commands-registry.js").listNativeCommandSpecs;
let listNativeCommandSpecsForConfig: typeof import("../../../src/auto-reply/commands-registry.js").listNativeCommandSpecsForConfig;
let normalizeTelegramCommandName: typeof import("./command-config.js").normalizeTelegramCommandName;
let createTelegramBotBase: typeof import("./bot.js").createTelegramBot;
let setTelegramBotRuntimeForTest: typeof import("./bot.js").setTelegramBotRuntimeForTest;
let createTelegramBot: (
  opts: Parameters<typeof import("./bot.js").createTelegramBot>[0],
) => ReturnType<typeof import("./bot.js").createTelegramBot>;

const loadConfig = getLoadConfigMock();

function createSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function waitForNextSetMyCommands() {
  const synced = createSignal();
  setMyCommandsSpy.mockImplementationOnce(async () => {
    synced.resolve();
    return undefined;
  });
  return synced.promise;
}

function resolveSkillCommands(config: Parameters<typeof listNativeCommandSpecsForConfig>[0]) {
  void config;
  return listSkillCommandsForAgents() as NonNullable<
    Parameters<typeof listNativeCommandSpecsForConfig>[1]
  >["skillCommands"];
}

describe("createTelegramBot command menu", () => {
  beforeAll(async () => {
    ({ listNativeCommandSpecs, listNativeCommandSpecsForConfig } =
      await import("../../../src/auto-reply/commands-registry.js"));
    ({ normalizeTelegramCommandName } = await import("./command-config.js"));
    ({ createTelegramBot: createTelegramBotBase, setTelegramBotRuntimeForTest } =
      await import("./bot.js"));
  });

  beforeEach(() => {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });
    setTelegramBotRuntimeForTest(
      telegramBotRuntimeForTest as unknown as Parameters<typeof setTelegramBotRuntimeForTest>[0],
    );
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
  });

  it("merges custom commands with native commands", async () => {
    const config = {
      commands: {
        native: true,
      },
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
          customCommands: [
            { command: "custom_backup", description: "Git backup" },
            { command: "/Custom_Generate", description: "Create an image" },
          ],
        },
      },
    } satisfies OpenClawConfig;
    loadConfig.mockReturnValue(config);
    const commandsSynced = waitForNextSetMyCommands();

    createTelegramBot({ token: "tok" });

    await commandsSynced;

    const registered = setMyCommandsSpy.mock.calls.at(-1)?.[0] as Array<{
      command: string;
      description: string;
    }>;
    const skillCommands = resolveSkillCommands(config);
    const native = listNativeCommandSpecsForConfig(config, { skillCommands }).map((command) => ({
      command: normalizeTelegramCommandName(command.name),
      description: command.description,
    }));
    expect(registered.slice(0, native.length)).toEqual(native);
  });

  it("ignores custom commands that collide with native commands", async () => {
    const errorSpy = vi.fn();
    const config = {
      commands: {
        native: true,
      },
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          customCommands: [
            { command: "status", description: "Custom status" },
            { command: "custom_backup", description: "Git backup" },
          ],
        },
      },
    } satisfies OpenClawConfig;
    loadConfig.mockReturnValue(config);
    const commandsSynced = waitForNextSetMyCommands();

    createTelegramBot({
      token: "tok",
      runtime: {
        log: vi.fn(),
        error: errorSpy,
        exit: ((code: number) => {
          throw new Error(`exit ${code}`);
        }) as (code: number) => never,
      },
    });

    await commandsSynced;

    const registered = setMyCommandsSpy.mock.calls[0]?.[0] as Array<{
      command: string;
      description: string;
    }>;
    const skillCommands = resolveSkillCommands(config);
    const native = listNativeCommandSpecsForConfig(config, { skillCommands }).map((command) => ({
      command: normalizeTelegramCommandName(command.name),
      description: command.description,
    }));
    const nativeStatus = native.find((command) => command.command === "status");
    expect(nativeStatus).toBeDefined();
    expect(registered).toContainEqual({ command: "custom_backup", description: "Git backup" });
    expect(registered).not.toContainEqual({ command: "status", description: "Custom status" });
    expect(registered.filter((command) => command.command === "status")).toEqual([nativeStatus]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("registers custom commands when native commands are disabled", async () => {
    const config = {
      commands: { native: false },
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          customCommands: [
            { command: "custom_backup", description: "Git backup" },
            { command: "custom_generate", description: "Create an image" },
          ],
        },
      },
    } satisfies OpenClawConfig;
    loadConfig.mockReturnValue(config);
    const commandsSynced = waitForNextSetMyCommands();

    createTelegramBot({ token: "tok" });

    await commandsSynced;

    const registered = setMyCommandsSpy.mock.calls[0]?.[0] as Array<{
      command: string;
      description: string;
    }>;
    expect(registered).toEqual([
      { command: "custom_backup", description: "Git backup" },
      { command: "custom_generate", description: "Create an image" },
    ]);
    const reserved = new Set(listNativeCommandSpecs().map((command) => command.name));
    expect(registered.some((command) => reserved.has(command.command))).toBe(false);
  });
});
