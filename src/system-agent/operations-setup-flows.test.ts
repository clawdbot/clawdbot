// Setup-flow operation tests cover parsing and deterministic one-shot guidance.
import { describe, expect, it } from "vitest";
import {
  executeSystemAgentOperation,
  isPersistentSystemAgentOperation,
  parseSystemAgentOperation,
} from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.test-helpers.js";

describe("system agent setup-flow operations", () => {
  it("parses channel listing and connect requests", () => {
    expect(parseSystemAgentOperation("channels")).toEqual({ kind: "channel-list" });
    expect(parseSystemAgentOperation("list channels")).toEqual({ kind: "channel-list" });
    expect(parseSystemAgentOperation("connect telegram")).toEqual({
      kind: "channel-setup",
      channel: "telegram",
    });
    expect(parseSystemAgentOperation("connect to WhatsApp")).toEqual({
      kind: "channel-setup",
      channel: "whatsapp",
    });
    expect(parseSystemAgentOperation("link discord channel")).toEqual({
      kind: "channel-setup",
      channel: "discord",
    });
    // Starting the wizard is not a write; the wizard collects explicit answers.
    expect(isPersistentSystemAgentOperation({ kind: "channel-setup", channel: "telegram" })).toBe(
      false,
    );
    expect(isPersistentSystemAgentOperation({ kind: "channel-list" })).toBe(false);
  });

  it("parses hosted skills, web-search, and Gateway setup requests", () => {
    for (const input of ["configure skills", "setup skills", "set up skills"]) {
      expect(parseSystemAgentOperation(input)).toEqual({ kind: "skills-setup" });
    }
    for (const input of [
      "configure search",
      "configure web search",
      "setup search",
      "web search provider setup",
    ]) {
      expect(parseSystemAgentOperation(input)).toEqual({ kind: "search-setup" });
    }
    expect(parseSystemAgentOperation("open search wizard")).toEqual({
      kind: "open-setup",
      target: "search",
    });
    for (const input of ["configure gateway", "set up gateway", "gateway settings"]) {
      expect(parseSystemAgentOperation(input)).toEqual({ kind: "gateway-config-setup" });
    }
    expect(parseSystemAgentOperation("open gateway wizard")).toEqual({
      kind: "open-setup",
      target: "gateway",
    });
    expect(isPersistentSystemAgentOperation({ kind: "skills-setup" })).toBe(false);
    expect(isPersistentSystemAgentOperation({ kind: "search-setup" })).toBe(false);
    expect(isPersistentSystemAgentOperation({ kind: "gateway-config-setup" })).toBe(false);
    expect(parseSystemAgentOperation("configure search with brave").kind).toBe("none");
  });

  it("parses the exact memory-import grammar", () => {
    for (const input of ["import memory", "import memories", "memory import"]) {
      expect(parseSystemAgentOperation(input)).toEqual({ kind: "memory-import" });
    }
    expect(isPersistentSystemAgentOperation({ kind: "memory-import" })).toBe(false);
    expect(parseSystemAgentOperation("import memory from codex").kind).toBe("none");
  });

  it("parses anchored setup switches and channel info", () => {
    for (const input of [
      "open setup wizard",
      "setup wizard",
      "menu setup",
      "use the setup wizard",
      "use the wizard",
    ]) {
      expect(parseSystemAgentOperation(input)).toEqual({ kind: "open-setup", target: "guided" });
    }
    for (const input of ["open classic wizard", "open classic setup wizard", "classic setup"]) {
      expect(parseSystemAgentOperation(input)).toEqual({ kind: "open-setup", target: "classic" });
    }
    expect(parseSystemAgentOperation("open channel wizard")).toEqual({
      kind: "open-setup",
      target: "channels",
    });
    expect(parseSystemAgentOperation("open channel wizard for Slack")).toEqual({
      kind: "open-setup",
      target: "channels",
      channel: "slack",
    });
    expect(parseSystemAgentOperation("channel info Slack")).toEqual({
      kind: "channel-info",
      channel: "slack",
    });
    expect(parseSystemAgentOperation("about Telegram channel")).toEqual({
      kind: "channel-info",
      channel: "telegram",
    });
    expect(parseSystemAgentOperation("please open the setup wizard soon").kind).toBe("none");
    expect(parseSystemAgentOperation("channel info slack please").kind).toBe("none");
  });

  it("prints one-shot setup pointers", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();

    for (const operation of [
      { kind: "open-setup", target: "guided" } as const,
      { kind: "open-setup", target: "classic" } as const,
      { kind: "open-setup", target: "channels", channel: "slack" } as const,
      { kind: "open-setup", target: "search" } as const,
      { kind: "open-setup", target: "gateway" } as const,
    ]) {
      const result = await executeSystemAgentOperation(operation, runtime);
      expect(result.applied).toBe(false);
    }

    const output = lines.join("\n");
    expect(output).toContain("openclaw onboard`");
    expect(output).toContain("openclaw onboard --classic");
    expect(output).toContain("openclaw channels add --channel slack");
    expect(output).toContain("openclaw configure --section web");
    expect(output).toContain("openclaw configure --section gateway");
    expect(output).toContain("on the machine running OpenClaw");
  });

  it("prints one-shot pointers for hosted skills, search, and Gateway setup", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();

    await executeSystemAgentOperation({ kind: "skills-setup" }, runtime);
    await executeSystemAgentOperation({ kind: "search-setup" }, runtime);
    await executeSystemAgentOperation({ kind: "gateway-config-setup" }, runtime);

    expect(lines.join("\n")).toContain("openclaw configure --section skills");
    expect(lines.join("\n")).toContain("openclaw configure --section web");
    expect(lines.join("\n")).toContain("openclaw configure --section gateway");
  });

  it("points one-shot memory import at interactive owners", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();

    await executeSystemAgentOperation({ kind: "memory-import" }, runtime);

    expect(lines.join("\n")).toContain("Memory page in the Control UI");
    expect(lines.join("\n")).toContain("openclaw onboard");
  });

  it("routes one-shot model setup through the verified OpenClaw flow", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();

    const result = await executeSystemAgentOperation({ kind: "model-setup" }, runtime);

    expect(result.applied).toBe(false);
    expect(lines.join("\n")).toContain("Run `openclaw onboard` on the machine running OpenClaw");
    expect(lines.join("\n")).toContain("Stop the OpenClaw host");
    expect(lines.join("\n")).toContain("restart the host");
    expect(lines.join("\n")).not.toContain("openclaw configure --section model");
  });

  it("prints discovered channel metadata and sorted unknown-channel choices", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const entries = [
      {
        id: "telegram",
        meta: {
          label: "Telegram",
          blurb: "Telegram bot messaging.",
          docsPath: "/channels/telegram",
        },
      },
      {
        id: "slack",
        meta: {
          label: "Slack",
          blurb: "Slack app messaging.",
          docsPath: "/channels/slack",
        },
      },
    ];
    const deps = {
      listChannelSetupPlugins: () => [{ id: "slack" }],
      resolveChannelSetupEntries: () => ({
        entries,
        installedCatalogEntries: [],
        installableCatalogEntries: [],
        installedCatalogById: new Map(),
        installableCatalogById: new Map(),
      }),
      isChannelConfigured: (_cfg: unknown, channel: string) => channel === "slack",
    } as never;

    await executeSystemAgentOperation({ kind: "channel-info", channel: "slack" }, runtime, {
      deps,
    });
    const knownOutput = lines.join("\n");
    expect(knownOutput).toContain("Slack (slack)");
    expect(knownOutput).toContain("Slack app messaging.");
    expect(knownOutput).toContain("Configured: yes");
    expect(knownOutput).toContain("Installed: yes");
    expect(knownOutput).toContain("https://docs.openclaw.ai/channels/slack");
    expect(knownOutput).toContain("open channel wizard for slack");

    lines.length = 0;
    await executeSystemAgentOperation({ kind: "channel-info", channel: "matrix" }, runtime, {
      deps,
    });
    expect(lines.join("\n")).toContain("Known channels: slack, telegram");
  });
});
