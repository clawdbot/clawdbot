import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCommandText,
  getCommandDetection,
  listChatCommands,
  listChatCommandsForConfig,
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
  normalizeCommandBody,
  shouldHandleTextCommands,
} from "./commands-registry.js";
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
    expect(normalizeCommandBody("/help@clawdbot", { botUsername: "clawdbot" })).toBe("/help");
    expect(
      normalizeCommandBody("/help@clawdbot args", {
        botUsername: "clawdbot",
      }),
    ).toBe("/help args");
    expect(
      normalizeCommandBody("/help@clawdbot: args", {
        botUsername: "clawdbot",
      }),
    ).toBe("/help args");
  });

  it("keeps telegram-style command mentions for other bots", () => {
    expect(normalizeCommandBody("/help@otherbot", { botUsername: "clawdbot" })).toBe(
      "/help@otherbot",
    );
  });

  it("normalizes dock command aliases", () => {
    expect(normalizeCommandBody("/dock_telegram")).toBe("/dock-telegram");
  });
});
