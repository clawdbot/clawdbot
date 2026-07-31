// Qqbot tests cover group command visibility classification.
import { describe, expect, it } from "vitest";
import { classifyCoreCommandForGroup } from "./command-visibility.js";

describe("QQBot command visibility", () => {
  it("parses slash command names case-insensitively", () => {
    expect(classifyCoreCommandForGroup(" /NEW now ").commandName).toBe("new");
    expect(classifyCoreCommandForGroup("/CONFIG: show").commandName).toBe("config");
    expect(classifyCoreCommandForGroup("/config：show").commandName).toBe("config");
    expect(classifyCoreCommandForGroup("/config@bot show").commandName).toBe("config");
    expect(classifyCoreCommandForGroup("hello").commandName).toBeUndefined();
  });

  it("keeps safe collaboration commands visible in groups", () => {
    for (const command of ["/help", "/btw side question", "/stop"]) {
      expect(classifyCoreCommandForGroup(command).visibility).toBe("group");
    }
  });

  it("keeps group-session controls callable but hidden from group menus", () => {
    for (const command of ["/new", "/reset", "/name", "/compact"]) {
      expect(classifyCoreCommandForGroup(command).visibility).toBe("hidden");
    }
    expect(classifyCoreCommandForGroup("/name", "safety").visibility).toBe("hidden");
  });

  it("marks sensitive core commands as private-only in groups", () => {
    for (const command of [
      "/config",
      "/bash",
      "/export-session",
      "/diagnostics",
      "/tts",
      "/steer",
      "/tell",
      "/model",
      "/models",
      "/status",
      "/verbose",
      "/v",
      "/config: show",
      "/model@bot sonnet",
    ]) {
      expect(classifyCoreCommandForGroup(command, "safety").visibility).toBe("private");
    }
  });

  it("keeps omitted command level compatible with all mode", () => {
    for (const command of ["/config", "/bash", "/new", "/status"]) {
      expect(classifyCoreCommandForGroup(command).visibility).not.toBe("private");
    }
  });

  it("allows every recognized core command in all mode", () => {
    for (const command of ["/config", "/bash", "/new", "/name", "/status"]) {
      expect(classifyCoreCommandForGroup(command, "all").visibility).not.toBe("private");
    }
  });

  it("keeps urgent stop callable in strict mode", () => {
    expect(classifyCoreCommandForGroup("/stop", "strict").visibility).toBe("group");
  });

  it("limits other core commands in strict mode", () => {
    expect(classifyCoreCommandForGroup("/new", "strict").visibility).toBe("hidden");
    expect(classifyCoreCommandForGroup("/reset", "strict").visibility).toBe("hidden");
    expect(classifyCoreCommandForGroup("/name", "strict").visibility).toBe("private");
    expect(classifyCoreCommandForGroup("/status", "strict").visibility).toBe("private");
    expect(classifyCoreCommandForGroup("/config", "strict").visibility).toBe("private");
  });

  it("keeps strict mode fail-closed for unclassified slash commands", () => {
    expect(classifyCoreCommandForGroup("/bot-dynamic", "strict").visibility).toBe("private");
    expect(classifyCoreCommandForGroup("/unknown", "strict").visibility).toBe("private");
  });

  it("does not make plugin and unknown slash commands private in all mode", () => {
    expect(classifyCoreCommandForGroup("/bot-help").visibility).not.toBe("private");
    expect(classifyCoreCommandForGroup("/unknown").visibility).not.toBe("private");
  });

  it("leaves plugin and unknown slash commands to their existing dispatch path in safety mode", () => {
    expect(classifyCoreCommandForGroup("/bot-help", "safety").visibility).toBe("unknown");
    expect(classifyCoreCommandForGroup("/unknown", "safety").visibility).toBe("unknown");
  });
});
