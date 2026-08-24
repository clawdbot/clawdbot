// Verifies TUI command definitions and parser metadata.
import { beforeAll, describe, expect, it } from "vitest";
import {
  getSlashCommands,
  helpText,
  parseCommand,
  shouldSubmitExactArgumentCompletion,
} from "./commands.js";

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

  it("accepts the hidden retired-name alias", () => {
    const retiredCommand = "/crestodian repair gateway"; // hidden alias
    expect(parseCommand(retiredCommand)).toEqual({
      name: "openclaw",
      args: "repair gateway",
    });
    expect(getSlashCommands().map((command) => command.name)).not.toContain("crestodian"); // hidden alias
    expect(helpText()).not.toContain("/crestodian"); // hidden alias
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

  it.each(["think", "fast"])("offers /%s default to clear the session override", (name) => {
    const command = getSlashCommands().find((candidate) => candidate.name === name);

    expect(command?.getArgumentCompletions?.("default")).toEqual([
      { value: "default", label: "default" },
    ]);
  });

  it.each([{}, { local: true }])("exposes usage cost in completion and help", (options) => {
    const commands = getSlashCommands(options);
    const usage = commands.find((command) => command.name === "usage");

    expect(usage?.description).toContain("cost summary");
    expect(usage?.getArgumentCompletions?.("co")).toEqual([{ value: "cost", label: "cost" }]);
    expect(shouldSubmitExactArgumentCompletion("/usage cost", commands)).toBe(true);
    expect(helpText(options)).toContain("/usage <off|tokens|full|cost|reset|");
  });

  it.each([
    { commandName: "verbose", level: "full", description: "Set verbose on/off/full" },
    { commandName: "reasoning", level: "stream", description: "Set reasoning on/off/stream" },
  ])(
    "exposes and submits the canonical /$commandName $level completion",
    ({ commandName, level, description }) => {
      const commands = getSlashCommands();
      const command = commands.find((candidate) => candidate.name === commandName);

      expect(command?.description).toBe(description);
      expect(command?.getArgumentCompletions?.(level)).toEqual([{ value: level, label: level }]);
      expect(shouldSubmitExactArgumentCompletion(`/${commandName} ${level}`, commands)).toBe(true);
    },
  );

  it("keeps session status on the shared command path and exposes gateway status separately", () => {
    const commands = getSlashCommands();
    const status = commands.find((command) => command.name === "status");
    const gatewayStatus = commands.find((command) => command.name === "gateway-status");
    const openclaw = commands.find((command) => command.name === "openclaw");
    expect(status?.description).toBe("Show current status.");
    expect(gatewayStatus?.description).toBe("Show gateway status summary");
    expect(openclaw?.description).toBe("Return to OpenClaw");
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
      { value: "default", label: "default" },
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
    expect(names).toEqual(expect.arrayContaining(["goal", "btw", "side", "queue", "stop", "t"]));
  });
});

describe("helpText", () => {
  it.each([{}, { local: true }])("documents multiline input shortcuts", (options) => {
    const output = helpText(options);

    expect(output).toContain("Enter: send message");
    expect(output).toContain("Shift+Enter or Ctrl+J: insert a newline");
  });

  it.each(["/verbose <on|off|full>", "/reasoning <on|off|stream>"])(
    "includes the full canonical directive levels for %s",
    (usage) => {
      expect(helpText()).toContain(usage);
    },
  );

  it("documents default reset values for model, thinking, and fast mode", () => {
    const output = helpText();

    expect(output).toContain("/model <provider/model|default>");
    expect(output).toMatch(/\/think <[^>]+\|default>/u);
    expect(output).toContain("/fast <status|auto|on|off|default>");
  });

  it("includes slash command help for aliases", () => {
    const output = helpText();
    expect(output).toContain("/elevated <on|off|ask|full>");
    expect(output).toContain("/elev <on|off|ask|full>");
    expect(output).toContain("/fast <status|auto|on|off|default>");
    expect(output).toContain("/gateway-status");
    expect(output).toContain("/gwstatus");
    expect(output).toContain("/openclaw [request]");
  });

  it.each(["goal", "btw", "queue", "stop"])(
    "keeps /%s visible in completion and help across TUI modes",
    (name) => {
      for (const options of [{}, { local: true }]) {
        expect(getSlashCommands(options).map((command) => command.name)).toContain(name);
        expect(helpText(options)).toContain(`/${name}`);
      }
    },
  );

  it.each([{}, { local: true }])("shows required arguments in shared command help", (options) => {
    const output = helpText(options);

    expect(output).toContain("/goal start <objective>");
    expect(output).toContain("/goal edit <objective>");
    expect(output).toContain("/btw <side question>");
    expect(output).not.toContain("/btw [side question]");
  });

  it("does not advertise Gateway-owned commands in local mode", () => {
    const output = helpText({ local: true });

    expect(output).not.toContain("/commands");
    expect(output).not.toContain("/status");
  });
});
