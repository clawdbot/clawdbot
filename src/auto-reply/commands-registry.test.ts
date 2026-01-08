import { describe, expect, it } from "vitest";

import {
  buildCommandText,
  getCommandDetection,
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
  });

  it("detects known text commands", () => {
    const detection = getCommandDetection();
    expect(detection.exact.has("/help")).toBe(true);
    expect(detection.regex.test("/status")).toBe(true);
    expect(detection.regex.test("/status:")).toBe(true);
    expect(detection.regex.test("/stop")).toBe(true);
    expect(detection.regex.test("/send:")).toBe(true);
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
