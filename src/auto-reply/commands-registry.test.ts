import { describe, expect, it } from "vitest";

import {
  buildCommandText,
  getCommandDetection,
  listChatCommands,
  listNativeCommandSpecs,
  shouldHandleTextCommands,
} from "./commands-registry.js";

describe("commands registry", () => {
  it("builds command text with args", () => {
    expect(buildCommandText("status")).toBe("/status");
    expect(buildCommandText("model", "gpt-5")).toBe("/model gpt-5");
  });

  it("exposes native specs", () => {
    const specs = listNativeCommandSpecs();
    expect(specs.find((spec) => spec.name === "help")).toBeTruthy();
    expect(specs.find((spec) => spec.name === "stop")).toBeTruthy();
    expect(specs.find((spec) => spec.name === "compact")).toBeFalsy();
  });

  it("detects known text commands", () => {
    const detection = getCommandDetection();
    expect(detection.exact.has("/commands")).toBe(true);
    expect(detection.exact.has("/compact")).toBe(true);
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
});
