import {
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
} from "openclaw/plugin-sdk/native-command-registry";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const {
  getLoadConfigMock,
  listSkillCommandsForAgents,
  setMyCommandsSpy,
  telegramBotDepsForTest,
  telegramBotRuntimeForTest,
} = await import("./bot.create-telegram-bot.test-harness.js");

let normalizeTelegramCommandName: typeof import("./command-config.js").normalizeTelegramCommandName;
let createTelegramBotBase: typeof import("./bot-core.js").createTelegramBotCore;
let setTelegramBotRuntimeForTest: typeof import("./bot-core.js").setTelegramBotRuntimeForTest;
let createTelegramBot: (
  opts: import("./bot.types.js").TelegramBotOptions,
) => ReturnType<typeof import("./bot-core.js").createTelegramBotCore>;

const loadConfig = getLoadConfigMock();

function createSignal() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected command sync signal resolver to be initialized");
  }
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

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

describe("createTelegramBot command menu", () => {
  beforeAll(async () => {
    ({ normalizeTelegramCommandName } = await import("./command-config.js"));
    ({ createTelegramBotCore: createTelegramBotBase, setTelegramBotRuntimeForTest } =
      await import("./bot-core.js"));
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
    expect(registered).toStrictEqual([
      ...native,
      { command: "custom_backup", description: "Git backup" },
      { command: "custom_generate", description: "Create an image" },
    ]);
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

    const registered = setMyCommandsSpy.mock.calls.at(-1)?.[0] as Array<{
      command: string;
      description: string;
    }>;
    const skillCommands = resolveSkillCommands(config);
    const native = listNativeCommandSpecsForConfig(config, { skillCommands }).map((command) => ({
      command: normalizeTelegramCommandName(command.name),
      description: command.description,
    }));
    const nativeStatus = native.find((command) => command.command === "status");
    if (!nativeStatus) {
      throw new Error("expected native Telegram status command");
    }
    expect(registered).toStrictEqual([
      ...native,
      { command: "custom_backup", description: "Git backup" },
    ]);
    expect(registered.find((command) => command.command === "status")).toEqual(nativeStatus);
    expect(countMatching(registered, (command) => command.command === "status")).toBe(1);
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

    const registered = setMyCommandsSpy.mock.calls.at(0)?.[0] as Array<{
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
