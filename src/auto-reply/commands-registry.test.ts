import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  buildCommandText,
  buildCommandTextFromArgs,
  findCommandByNativeName,
  formatCommandArgMenuTitle,
  getCommandDetection,
  listChatCommands,
  listChatCommandsForConfig,
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
  normalizeCommandBody,
  parseCommandArgs,
  resolveCommandArgChoices,
  resolveCommandArgMenu,
  serializeCommandArgs,
  shouldHandleTextCommands,
} from "./commands-registry.js";
import type { ChatCommandDefinition } from "./commands-registry.types.js";

type NativeCommandNameResolver = (params: { commandKey: string; defaultName: string }) => string;

function installNativeCommandOverridePlugin(params: {
  id: "discord" | "slack";
  resolveNativeCommandName: NativeCommandNameResolver;
}) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: params.id,
        plugin: {
          ...createChannelTestPluginBase({
            id: params.id,
            capabilities: { nativeCommands: true, chatTypes: ["direct"] },
          }),
          commands: {
            resolveNativeCommandName: params.resolveNativeCommandName,
          },
        },
        source: "test",
      },
    ]),
  );
}

function installDiscordNativeCommandOverrides() {
  installNativeCommandOverridePlugin({
    id: "discord",
    resolveNativeCommandName: ({ commandKey, defaultName }) =>
      commandKey === "tts" ? "voice" : defaultName,
  });
}

function installSlackNativeCommandOverrides() {
  installNativeCommandOverridePlugin({
    id: "slack",
    resolveNativeCommandName: ({ commandKey, defaultName }) =>
      commandKey === "status" ? "agentstatus" : defaultName,
  });
}

function installOllamaThinkingProvider() {
  const registry = createTestRegistry();
  registry.providers.push({
    pluginId: "ollama",
    source: "test",
    provider: {
      id: "ollama",
      label: "Ollama",
      auth: [],
      resolveThinkingProfile: ({ reasoning }: { reasoning?: boolean }) => ({
        levels:
          reasoning === true
            ? [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }]
            : [{ id: "off" }],
        defaultLevel: "off",
      }),
    } as never,
  });
  setActivePluginRegistry(registry);
}

beforeEach(() => {
  vi.doUnmock("../channels/plugins/index.js");
  setActivePluginRegistry(createTestRegistry([]));
});

afterEach(() => {
  setActivePluginRegistry(createTestRegistry([]));
});

describe("commands registry", () => {
  it("builds command text with args", () => {
    expect(buildCommandText("status")).toBe("/status");
    expect(buildCommandText("tasks")).toBe("/tasks");
    expect(buildCommandText("model", "gpt-5")).toBe("/model gpt-5");
    expect(buildCommandText("models")).toBe("/models");
  });

  it("exposes native specs", () => {
    const specs = listNativeCommandSpecs();
    expect(specs.find((spec) => spec.name === "help")).toBeTruthy();
    expect(specs.find((spec) => spec.name === "stop")).toBeTruthy();
    expect(specs.find((spec) => spec.name === "skill")).toBeTruthy();
    expect(specs.find((spec) => spec.name === "tasks")).toBeTruthy();
    expect(specs.find((spec) => spec.name === "whoami")).toBeTruthy();
    expect(specs.find((spec) => spec.name === "compact")).toBeTruthy();
  });

  it("filters commands based on config flags", () => {
    const disabled = listChatCommandsForConfig({
      commands: { config: false, plugins: false, debug: false },
    });
    expect(disabled.find((spec) => spec.key === "config")).toBeFalsy();
    expect(disabled.find((spec) => spec.key === "plugins")).toBeFalsy();
    expect(disabled.find((spec) => spec.key === "debug")).toBeFalsy();

    const enabled = listChatCommandsForConfig({
      commands: { config: true, plugins: true, debug: true },
    });
    expect(enabled.find((spec) => spec.key === "config")).toBeTruthy();
    expect(enabled.find((spec) => spec.key === "plugins")).toBeTruthy();
    expect(enabled.find((spec) => spec.key === "debug")).toBeTruthy();

    const nativeDisabled = listNativeCommandSpecsForConfig({
      commands: { config: false, plugins: false, debug: false, native: true },
    });
    expect(nativeDisabled.find((spec) => spec.name === "config")).toBeFalsy();
    expect(nativeDisabled.find((spec) => spec.name === "plugins")).toBeFalsy();
    expect(nativeDisabled.find((spec) => spec.name === "debug")).toBeFalsy();
  });

  it("does not enable restricted commands from inherited flags", () => {
    const inheritedCommands = Object.create({
      config: true,
      plugins: true,
      debug: true,
      bash: true,
    }) as Record<string, unknown>;
    const commands = listChatCommandsForConfig({
      commands: inheritedCommands as never,
    });
    expect(commands.find((spec) => spec.key === "config")).toBeFalsy();
    expect(commands.find((spec) => spec.key === "plugins")).toBeFalsy();
    expect(commands.find((spec) => spec.key === "debug")).toBeFalsy();
    expect(commands.find((spec) => spec.key === "bash")).toBeFalsy();
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
        commands: { config: false, plugins: false, debug: false },
      },
      { skillCommands },
    );
    expect(commands.find((spec) => spec.nativeName === "demo_skill")).toBeTruthy();
    expect(commands.find((spec) => spec.nativeName === "demo_skill")).toMatchObject({
      category: "tools",
    });

    const native = listNativeCommandSpecsForConfig(
      { commands: { config: false, plugins: false, debug: false, native: true } },
      { skillCommands },
    );
    expect(native.find((spec) => spec.name === "demo_skill")).toBeTruthy();
  });

  it("applies discord native command overrides", () => {
    installDiscordNativeCommandOverrides();
    const native = listNativeCommandSpecsForConfig(
      { commands: { native: true } },
      { provider: "discord" },
    );
    expect(native.find((spec) => spec.name === "voice")).toBeTruthy();
    expect(findCommandByNativeName("voice", "discord")?.key).toBe("tts");
    expect(findCommandByNativeName("tts", "discord")).toBeUndefined();
  });

  it("applies slack native command overrides", () => {
    installSlackNativeCommandOverrides();
    const native = listNativeCommandSpecsForConfig(
      { commands: { native: true } },
      { provider: "slack" },
    );
    expect(native.find((spec) => spec.name === "agentstatus")).toBeTruthy();
    expect(findCommandByNativeName("agentstatus", "slack")?.key).toBe("status");
    expect(findCommandByNativeName("status", "slack")).toBeUndefined();
    expect(
      findCommandByNativeName("agentstatus", "slack", {
        includeBundledChannelFallback: false,
      })?.key,
    ).toBe("status");
    expect(
      findCommandByNativeName("status", "slack", {
        includeBundledChannelFallback: false,
      }),
    ).toBeUndefined();
  });

  it("can resolve default native command names without loading bundled channel fallbacks", () => {
    expect(
      findCommandByNativeName("status", "discord", {
        includeBundledChannelFallback: false,
      })?.key,
    ).toBe("status");
  });

  it("keeps discord native command specs within slash-command limits", () => {
    installDiscordNativeCommandOverrides();
    const cfg = { commands: { native: true } };
    const native = listNativeCommandSpecsForConfig(cfg, { provider: "discord" });
    for (const spec of native) {
      expect(spec.name).toMatch(/^[a-z0-9_-]{1,32}$/);
      expect(spec.description.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeLessThanOrEqual(100);
      expect(spec.args?.length ?? 0).toBeLessThanOrEqual(25);

      const command = findCommandByNativeName(spec.name, "discord");
      expect(command).toBeTruthy();

      const args = command?.args ?? spec.args ?? [];
      const argNames = new Set<string>();
      let sawOptional = false;
      for (const arg of args) {
        expect(argNames.has(arg.name)).toBe(false);
        argNames.add(arg.name);

        const isRequired = arg.required ?? false;
        if (!isRequired) {
          sawOptional = true;
        } else {
          expect(sawOptional).toBe(false);
        }

        expect(arg.name).toMatch(/^[a-z0-9_-]{1,32}$/);
        expect(arg.description.length).toBeGreaterThan(0);
        expect(arg.description.length).toBeLessThanOrEqual(100);

        if (!command) {
          continue;
        }
        const choices = resolveCommandArgChoices({
          command,
          arg,
          cfg,
          provider: "discord",
        });
        if (choices.length === 0) {
          continue;
        }
        expect(choices.length).toBeLessThanOrEqual(25);
        for (const choice of choices) {
          expect(choice.label.length).toBeGreaterThan(0);
          expect(choice.label.length).toBeLessThanOrEqual(100);
          expect(choice.value.length).toBeGreaterThan(0);
          expect(choice.value.length).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  it("keeps ACP native action choices aligned with implemented handlers", () => {
    const acp = listChatCommands().find((command) => command.key === "acp");
    expect(acp).toBeTruthy();
    const actionArg = acp?.args?.find((arg) => arg.name === "action");
    expect(actionArg?.choices).toEqual([
      "spawn",
      "cancel",
      "steer",
      "close",
      "sessions",
      "status",
      "set-mode",
      "set",
      "cwd",
      "permissions",
      "timeout",
      "model",
      "reset-options",
      "doctor",
      "install",
      "help",
    ]);
  });

  it("registers fast mode as a first-class options command", () => {
    const fast = listChatCommands().find((command) => command.key === "fast");
    expect(fast).toMatchObject({
      nativeName: "fast",
      textAliases: ["/fast"],
      category: "options",
    });
    const modeArg = fast?.args?.find((arg) => arg.name === "mode");
    expect(modeArg?.choices).toEqual(["status", "on", "off"]);
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
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          plugin: createChannelTestPluginBase({
            id: "discord",
            capabilities: { nativeCommands: true, chatTypes: ["direct"] },
          }),
          source: "test",
        },
      ]),
    );
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
    expect(normalizeCommandBody("/help@openclaw", { botUsername: "openclaw" })).toBe("/help");
    expect(
      normalizeCommandBody("/help@openclaw args", {
        botUsername: "openclaw",
      }),
    ).toBe("/help args");
    expect(
      normalizeCommandBody("/help@openclaw: args", {
        botUsername: "openclaw",
      }),
    ).toBe("/help args");
  });

  it("keeps telegram-style command mentions for other bots", () => {
    expect(normalizeCommandBody("/help@otherbot", { botUsername: "openclaw" })).toBe(
      "/help@otherbot",
    );
  });

  it("keeps unregistered dock underscore aliases unchanged", () => {
    expect(normalizeCommandBody("/dock_telegram")).toBe("/dock_telegram");
  });
});

describe("commands registry args", () => {
  function createUsageModeCommand(
    argsParsing: ChatCommandDefinition["argsParsing"] = "positional",
    description = "mode",
  ): ChatCommandDefinition {
    return {
      key: "usage",
      description: "usage",
      textAliases: [],
      scope: "both",
      argsMenu: "auto",
      argsParsing,
      args: [
        {
          name: "mode",
          description,
          type: "string",
          choices: ["off", "tokens", "full", "cost"],
        },
      ],
    };
  }

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

    expect(serializeCommandArgs(command, { raw: "gpt-5.4" })).toBe("gpt-5.4");
    expect(serializeCommandArgs(command, { values: { model: "gpt-5.4" } })).toBe("gpt-5.4");
    expect(buildCommandTextFromArgs(command, { values: { model: "gpt-5.4" } })).toBe(
      "/model gpt-5.4",
    );
  });

  it("resolves auto arg menus when missing a choice arg", () => {
    const command = createUsageModeCommand();

    const menu = resolveCommandArgMenu({ command, args: undefined, cfg: {} as never });
    expect(menu?.arg.name).toBe("mode");
    expect(menu?.choices).toEqual([
      { label: "off", value: "off" },
      { label: "tokens", value: "tokens" },
      { label: "full", value: "full" },
      { label: "cost", value: "cost" },
    ]);
  });

  it("keeps verbose full available while preserving no-arg status dispatch", () => {
    const verbose = listChatCommands().find((command) => command.key === "verbose");

    expect(verbose?.args?.[0]?.choices).toEqual(["on", "off", "full"]);
    expect(
      resolveCommandArgMenu({ command: verbose!, args: undefined, cfg: {} as never }),
    ).toBeNull();
  });

  it("does not show menus when arg already provided", () => {
    const command = createUsageModeCommand();

    const menu = resolveCommandArgMenu({
      command,
      args: { values: { mode: "tokens" } },
      cfg: {} as never,
    });
    expect(menu).toBeNull();
  });

  it("resolves function-based choices with a default provider/model context", () => {
    let seen: {
      provider?: string;
      model?: string;
      catalogLength?: number;
      commandKey: string;
      argName: string;
    } | null = null;

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
          choices: ({ provider, model, catalog, command, arg }) => {
            seen = {
              provider,
              model,
              catalogLength: catalog?.length,
              commandKey: command.key,
              argName: arg.name,
            };
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
    expect(formatCommandArgMenuTitle({ command, menu: menu! })).toBe(
      "Choose level for /think.\nOptions: low, high.",
    );
    const seenChoice = seen as {
      provider?: string;
      model?: string;
      catalogLength?: number;
      commandKey: string;
      argName: string;
    } | null;
    expect(seenChoice?.commandKey).toBe("think");
    expect(seenChoice?.argName).toBe("level");
    expect(seenChoice?.provider).toBeTruthy();
    expect(seenChoice?.model).toBeTruthy();
    expect(seenChoice?.catalogLength).toBe(0);
  });

  it("uses configured model catalog reasoning for /think arg menus", () => {
    installOllamaThinkingProvider();
    const command = findCommandByNativeName("think");
    expect(command).toBeTruthy();
    if (!command) {
      return;
    }

    const menu = resolveCommandArgMenu({
      command,
      args: undefined,
      cfg: {
        models: {
          providers: {
            ollama: {
              models: [{ id: "glm-5.1:cloud", name: "GLM 5.1 Cloud", reasoning: true }],
            },
          },
        },
      } as never,
      provider: "ollama",
      model: "glm-5.1:cloud",
    });

    expect(menu?.arg.name).toBe("level");
    expect(menu?.choices.map((choice) => choice.value)).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(formatCommandArgMenuTitle({ command, menu: menu! })).toBe(
      "Choose level for /think.\nOptions: off, low, medium, high, max.",
    );
  });

  it("uses configured model compat for /think arg menus", () => {
    const command = findCommandByNativeName("think");
    expect(command).toBeTruthy();
    if (!command) {
      return;
    }

    const menu = resolveCommandArgMenu({
      command,
      args: undefined,
      cfg: {
        models: {
          providers: {
            gmn: {
              models: [
                {
                  id: "gpt-5.4",
                  name: "GPT 5.4 via GMN",
                  reasoning: true,
                  compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
                },
              ],
            },
          },
        },
      } as never,
      provider: "gmn",
      model: "gpt-5.4",
    });

    expect(menu?.choices.map((choice) => choice.value)).toContain("xhigh");
    expect(formatCommandArgMenuTitle({ command, menu: menu! })).toContain("xhigh");
  });

  it("does not show menus when args were provided as raw text only", () => {
    const command = createUsageModeCommand("none", "on or off");

    const menu = resolveCommandArgMenu({
      command,
      args: { raw: "on" },
      cfg: {} as never,
    });
    expect(menu).toBeNull();
  });
});
