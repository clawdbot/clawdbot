import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCommandText,
  buildCommandTextFromArgs,
  findCommandByNativeName,
  getCommandDetection,
  listChatCommands,
  listChatCommandsForConfig,
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
  normalizeCommandBody,
  parseCommandArgs,
  resolveCommandArgMenu,
  serializeCommandArgs,
  shouldHandleTextCommands,
} from "./commands-registry.js";
import type { ChatCommandDefinition } from "./commands-registry.types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";

beforeEach(() => {
  setActivePluginRegistry(createTestRegistry([]));
});

afterEach(() => {
  setActivePluginRegistry(createTestRegistry([]));
});

describe("commands registry", () => {
  it("builds command text with args", () => {
    expect(buildCommandText("status")).toBe("/status");
    expect(buildCommandText("model", "gpt-5")).toBe("/model gpt-5");
    expect(buildCommandText("models")).toBe("/models");
  });

  it("exposes native specs", () => {
    const specs = listNativeCommandSpecs();
    expect(specs.find((spec) => spec.name === "help")).toBeTruthy();
    expect(specs.find((spec) => spec.name === "stop")).toBeTruthy();
    expect(specs.find((spec) => spec.name === "skill")).toBeTruthy();
    expect(specs.find((spec) => spec.name === "whoami")).toBeTruthy();
    expect(specs.find((spec) => spec.name === "compact")).toBeFalsy();
  });

  it("filters commands based on config flags", () => {
    const disabled = listChatCommandsForConfig({
      commands: { config: false, debug: false },
    });
    expect(disabled.find((spec) => spec.key === "config")).toBeFalsy();
    expect(disabled.find((spec) => spec.key === "debug")).toBeFalsy();

    const enabled = listChatCommandsForConfig({
      commands: { config: true, debug: true },
    });
    expect(enabled.find((spec) => spec.key === "config")).toBeTruthy();
    expect(enabled.find((spec) => spec.key === "debug")).toBeTruthy();

    const nativeDisabled = listNativeCommandSpecsForConfig({
      commands: { config: false, debug: false, native: true },
    });
    expect(nativeDisabled.find((spec) => spec.name === "config")).toBeFalsy();
    expect(nativeDisabled.find((spec) => spec.name === "debug")).toBeFalsy();
  });

  it("appends skill commands when provided", () => {
    const skillCommands = [
      {
        name: "demo_skill",
        skillName: "demo-skill",
        description: "Demo skill",
      },
    ];
    const commands = listChatCommandsForConfig(
      {
        commands: { config: false, debug: false },
      },
      { skillCommands },
    );
    expect(commands.find((spec) => spec.nativeName === "demo_skill")).toBeTruthy();

    const native = listNativeCommandSpecsForConfig(
      { commands: { config: false, debug: false, native: true } },
      { skillCommands },
    );
    expect(native.find((spec) => spec.name === "demo_skill")).toBeTruthy();
  });

  it("applies provider-specific native names", () => {
    const native = listNativeCommandSpecsForConfig(
      { commands: { native: true } },
      { provider: "discord" },
    );
    expect(native.find((spec) => spec.name === "voice")).toBeTruthy();
    expect(findCommandByNativeName("voice", "discord")?.key).toBe("tts");
    expect(findCommandByNativeName("tts", "discord")).toBeUndefined();
  });

  it("detects known text commands", () => {
    const detection = getCommandDetection();
    expect(detection.exact.has("/commands")).toBe(true);
    expect(detection.exact.has("/skill")).toBe(true);
    expect(detection.exact.has("/compact")).toBe(true);
    expect(detection.exact.has("/whoami")).toBe(true);
    expect(detection.exact.has("/id")).toBe(true);
    for (const command of listChatCommands()) {
      for (const alias of command.textAliases) {
        expect(detection.exact.has(alias.toLowerCase())).toBe(true);
        expect(detection.regex.test(alias)).toBe(true);
        expect(detection.regex.test(`${alias}:`)).toBe(true);

        if (command.acceptsArgs) {
          expect(detection.regex.test(`${alias} list`)).toBe(true);
          expect(detection.regex.test(`${alias}: list`)).toBe(true);
        } else {
          expect(detection.regex.test(`${alias} list`)).toBe(false);
          expect(detection.regex.test(`${alias}: list`)).toBe(false);
        }
      }
    }
    expect(detection.regex.test("try /status")).toBe(false);
  });

  it("respects text command gating", () => {
    const cfg = { commands: { text: false } };
    expect(
      shouldHandleTextCommands({
        cfg,
        surface: "discord",
        commandSource: "text",
      }),
    ).toBe(false);
    expect(
      shouldHandleTextCommands({
        cfg,
        surface: "whatsapp",
        commandSource: "text",
      }),
    ).toBe(true);
    expect(
      shouldHandleTextCommands({
        cfg,
        surface: "discord",
        commandSource: "native",
      }),
    ).toBe(true);
  });

  it("normalizes telegram-style command mentions for the current bot", () => {
    expect(normalizeCommandBody("/help@moltbot", { botUsername: "moltbot" })).toBe("/help");
    expect(
      normalizeCommandBody("/help@moltbot args", {
        botUsername: "moltbot",
      }),
    ).toBe("/help args");
    expect(
      normalizeCommandBody("/help@moltbot: args", {
        botUsername: "moltbot",
      }),
    ).toBe("/help args");
  });

  it("keeps telegram-style command mentions for other bots", () => {
    expect(normalizeCommandBody("/help@otherbot", { botUsername: "moltbot" })).toBe(
      "/help@otherbot",
    );
  });

  it("normalizes dock command aliases", () => {
    expect(normalizeCommandBody("/dock_telegram")).toBe("/dock-telegram");
  });
});

describe("commands registry args", () => {
  it("parses positional args and captureRemaining", () => {
    const command: ChatCommandDefinition = {
      key: "debug",
      description: "debug",
      textAliases: [],
      scope: "both",
      argsParsing: "positional",
      args: [
        { name: "action", description: "action", type: "string" },
        { name: "path", description: "path", type: "string" },
        { name: "value", description: "value", type: "string", captureRemaining: true },
      ],
    };

    const args = parseCommandArgs(command, "set foo bar baz");
    expect(args?.values).toEqual({ action: "set", path: "foo", value: "bar baz" });
  });

  it("serializes args via raw first, then values", () => {
    const command: ChatCommandDefinition = {
      key: "model",
      description: "model",
      textAliases: [],
      scope: "both",
      argsParsing: "positional",
      args: [{ name: "model", description: "model", type: "string", captureRemaining: true }],
    };

    expect(serializeCommandArgs(command, { raw: "gpt-5.2-codex" })).toBe("gpt-5.2-codex");
    expect(serializeCommandArgs(command, { values: { model: "gpt-5.2-codex" } })).toBe(
      "gpt-5.2-codex",
    );
    expect(buildCommandTextFromArgs(command, { values: { model: "gpt-5.2-codex" } })).toBe(
      "/model gpt-5.2-codex",
    );
  });

  it("resolves auto arg menus when missing a choice arg", () => {
    const command: ChatCommandDefinition = {
      key: "usage",
      description: "usage",
      textAliases: [],
      scope: "both",
      argsMenu: "auto",
      argsParsing: "positional",
      args: [
        {
          name: "mode",
          description: "mode",
          type: "string",
          choices: ["off", "tokens", "full", "cost"],
        },
      ],
    };

    const menu = resolveCommandArgMenu({ command, args: undefined, cfg: {} as never });
    expect(menu?.arg.name).toBe("mode");
    expect(menu?.choices).toEqual([
      { label: "off", value: "off" },
      { label: "tokens", value: "tokens" },
      { label: "full", value: "full" },
      { label: "cost", value: "cost" },
    ]);
  });

  it("does not show menus when arg already provided", () => {
    const command: ChatCommandDefinition = {
      key: "usage",
      description: "usage",
      textAliases: [],
      scope: "both",
      argsMenu: "auto",
      argsParsing: "positional",
      args: [
        {
          name: "mode",
          description: "mode",
          type: "string",
          choices: ["off", "tokens", "full", "cost"],
        },
      ],
    };

    const menu = resolveCommandArgMenu({
      command,
      args: { values: { mode: "tokens" } },
      cfg: {} as never,
    });
    expect(menu).toBeNull();
  });

  it("resolves function-based choices with a default provider/model context", () => {
    let seen: { provider: string; model: string; commandKey: string; argName: string } | null =
      null;

    const command: ChatCommandDefinition = {
      key: "think",
      description: "think",
      textAliases: [],
      scope: "both",
      argsMenu: "auto",
      argsParsing: "positional",
      args: [
        {
          name: "level",
          description: "level",
          type: "string",
          choices: ({ provider, model, command, arg }) => {
            seen = { provider, model, commandKey: command.key, argName: arg.name };
            return ["low", "high"];
          },
        },
      ],
    };

    const menu = resolveCommandArgMenu({ command, args: undefined, cfg: {} as never });
    expect(menu?.arg.name).toBe("level");
    expect(menu?.choices).toEqual([
      { label: "low", value: "low" },
      { label: "high", value: "high" },
    ]);
    expect(seen?.commandKey).toBe("think");
    expect(seen?.argName).toBe("level");
    expect(seen?.provider).toBeTruthy();
    expect(seen?.model).toBeTruthy();
  });

  it("does not show menus when args were provided as raw text only", () => {
    const command: ChatCommandDefinition = {
      key: "usage",
      description: "usage",
      textAliases: [],
      scope: "both",
      argsMenu: "auto",
      argsParsing: "none",
      args: [
        {
          name: "mode",
          description: "on or off",
          type: "string",
          choices: ["off", "tokens", "full", "cost"],
        },
      ],
    };

    const menu = resolveCommandArgMenu({
      command,
      args: { raw: "on" },
      cfg: {} as never,
    });
    expect(menu).toBeNull();
  });
});
