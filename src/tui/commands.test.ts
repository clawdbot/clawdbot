// Verifies TUI command definitions and parser metadata.
import { beforeAll, describe, expect, it } from "vitest";
import { getSlashCommands, helpText, parseCommand } from "./commands.js";

describe("parseCommand", () => {
  it("normalizes aliases and keeps command args", () => {
    expect(parseCommand("/elev full")).toEqual({ name: "elevated", args: "full" });
    expect(parseCommand("/t high")).toEqual({ name: "think", args: "high" });
    expect(parseCommand("/side check this")).toEqual({ name: "btw", args: "check this" });
    expect(parseCommand("/compact: focus on decisions")).toEqual({
      name: "compact",
      args: "focus on decisions",
    });
  });

  it("normalizes gateway-status aliases", () => {
    expect(parseCommand("/gwstatus")).toEqual({ name: "gateway-status", args: "" });
  });

  it("returns empty name for empty input", () => {
    expect(parseCommand("   ")).toEqual({ name: "", args: "" });
  });
});

describe("getSlashCommands", () => {
  beforeAll(() => {
    // Provider thinking policies are process-stable; warm the fallback before timing assertions.
    getSlashCommands({ provider: "minimax", model: "MiniMax-M3", thinkingLevels: [] });
  });

  it("provides level completions for built-in toggles", () => {
    const commands = getSlashCommands();
    const verbose = commands.find((command) => command.name === "verbose");
    const activation = commands.find((command) => command.name === "activation");
    expect(verbose?.getArgumentCompletions?.("o")).toEqual([
      { value: "on", label: "on" },
      { value: "off", label: "off" },
    ]);
    expect(activation?.getArgumentCompletions?.("a")).toEqual([
      { value: "always", label: "always" },
    ]);
  });

  it("keeps session status on the shared command path and exposes gateway status separately", () => {
    const commands = getSlashCommands();
    const status = commands.find((command) => command.name === "status");
    const gatewayStatus = commands.find((command) => command.name === "gateway-status");
    const crestodian = commands.find((command) => command.name === "crestodian");
    expect(status?.description).toBe("Show current status.");
    expect(gatewayStatus?.description).toBe("Show gateway status summary");
    expect(crestodian?.description).toBe("Return to Crestodian");
  });

  it("distinguishes new-session and reset command descriptions", () => {
    const commands = getSlashCommands();
    const newSession = commands.find((command) => command.name === "new");
    const reset = commands.find((command) => command.name === "reset");
    expect(newSession?.description).toBe("Spawn a new isolated session");
    expect(reset?.description).toBe("Reset the current session");
  });

  it("uses session-provided thinking levels for completions", () => {
    const commands = getSlashCommands({
      provider: "ollama",
      model: "qwen3:0.6b",
      thinkingLevels: [
        { id: "off", label: "off" },
        { id: "medium", label: "medium" },
        { id: "max", label: "max" },
      ],
    });
    const think = commands.find((command) => command.name === "think");
    expect(think?.getArgumentCompletions?.("m")).toEqual([
      { value: "medium", label: "medium" },
      { value: "max", label: "max" },
    ]);
  });

  it("falls back to provider-resolved levels when thinkingLevels is empty (#76482)", () => {
    const commands = getSlashCommands({
      provider: "minimax",
      model: "MiniMax-M3",
      thinkingLevels: [], // empty from lightweight session row
    });
    const think = commands.find((command) => command.name === "think");
    // Should fall back to listThinkingLevelLabels, not return empty completions
    const completions = think?.getArgumentCompletions?.("");
    expect(Array.isArray(completions)).toBe(true);
    if (!Array.isArray(completions)) {
      throw new Error("expected synchronous thinking-level completions");
    }
    expect(completions).toEqual([
      { value: "off", label: "off" },
      { value: "adaptive", label: "adaptive" },
    ]);
  });

  it.each([
    { model: "gpt-5.6-sol", agentRuntime: "codex", supportsUltra: true },
    { model: "gpt-5.6-terra", agentRuntime: "codex", supportsUltra: true },
    { model: "gpt-5.6-luna", agentRuntime: "codex", supportsUltra: false },
    { model: "gpt-5.6-luna", agentRuntime: "openclaw", supportsUltra: true },
  ])(
    "uses the $agentRuntime profile for openai/$model thinking completions",
    ({ model, agentRuntime, supportsUltra }) => {
      const think = getSlashCommands({
        provider: "openai",
        model,
        agentRuntime,
        thinkingLevels: [],
      }).find((command) => command.name === "think");
      const completions = think?.getArgumentCompletions?.("");
      if (!Array.isArray(completions)) {
        throw new Error("expected synchronous thinking-level completions");
      }

      expect(completions.some((choice) => choice.value === "ultra")).toBe(supportsUltra);
    },
  );

  it("merges dynamic gateway commands", () => {
    const commands = getSlashCommands({
      dynamicCommands: [
        {
          name: "dreaming",
          textAliases: ["/dreaming"],
          description: "Enable or disable memory dreaming.",
          source: "plugin",
          scope: "both",
          acceptsArgs: true,
        },
      ],
    });

    expect(commands.find((command) => command.name === "dreaming")?.description).toBe(
      "Enable or disable memory dreaming.",
    );
  });

  it("only advertises shared commands that local mode can route", () => {
    const names = getSlashCommands({ local: true }).map((command) => command.name);

    expect(names).toEqual(
      expect.not.arrayContaining(["commands", "status", "compact", "context", "tools"]),
    );
    expect(names).toEqual(expect.arrayContaining(["goal", "btw", "side", "stop", "t"]));
  });
});

describe("helpText", () => {
  it("includes slash command help for aliases", () => {
    const output = helpText();
    expect(output).toContain("/elevated <on|off|ask|full>");
    expect(output).toContain("/elev <on|off|ask|full>");
    expect(output).toContain("/fast <status|auto|on|off>");
    expect(output).toContain("/gateway-status");
    expect(output).toContain("/gwstatus");
    expect(output).toContain("/crestodian [request]");
  });

  it("does not advertise Gateway-owned commands in local mode", () => {
    const output = helpText({ local: true });

    expect(output).not.toContain("/commands");
    expect(output).not.toContain("/status");
  });
});
