import { describe, expect, it, vi } from "vitest";

import type { MoltbotConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { buildCommandContext, handleCommands } from "./commands.js";
import { parseInlineDirectives } from "./directive-handling.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const validateConfigObjectWithPluginsMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn());

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    readConfigFileSnapshot: readConfigFileSnapshotMock,
    validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
    writeConfigFile: writeConfigFileMock,
  };
});

const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn());
const addChannelAllowFromStoreEntryMock = vi.hoisted(() => vi.fn());
const removeChannelAllowFromStoreEntryMock = vi.hoisted(() => vi.fn());

vi.mock("../../pairing/pairing-store.js", async () => {
  const actual = await vi.importActual<typeof import("../../pairing/pairing-store.js")>(
    "../../pairing/pairing-store.js",
  );
  return {
    ...actual,
    readChannelAllowFromStore: readChannelAllowFromStoreMock,
    addChannelAllowFromStoreEntry: addChannelAllowFromStoreEntryMock,
    removeChannelAllowFromStoreEntry: removeChannelAllowFromStoreEntryMock,
  };
});

vi.mock("../../channels/plugins/pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/plugins/pairing.js")>(
    "../../channels/plugins/pairing.js",
  );
  return {
    ...actual,
    listPairingChannels: () => ["telegram"],
  };
});

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
    { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
    { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
    { provider: "google", id: "gemini-2.0-flash", name: "Gemini Flash" },
  ]),
}));

function buildParams(commandBody: string, cfg: MoltbotConfig, ctxOverrides?: Partial<MsgContext>) {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "telegram",
    Surface: "telegram",
    ...ctxOverrides,
  } as MsgContext;

  const command = buildCommandContext({
    ctx,
    cfg,
    isGroup: false,
    triggerBodyNormalized: commandBody.trim().toLowerCase(),
    commandAuthorized: true,
  });

  return {
    ctx,
    cfg,
    command,
    directives: parseInlineDirectives(commandBody),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off" as const,
    resolvedReasoningLevel: "off" as const,
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "telegram",
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
}

describe("handleCommands /allowlist", () => {
  it("lists config + store allowFrom entries", async () => {
    readChannelAllowFromStoreMock.mockResolvedValueOnce(["456"]);

    const cfg = {
      commands: { text: true },
      channels: { telegram: { allowFrom: ["123", "@Alice"] } },
    } as MoltbotConfig;
    const params = buildParams("/allowlist list dm", cfg);
    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Channel: telegram");
    expect(result.reply?.text).toContain("DM allowFrom (config): 123, @alice");
    expect(result.reply?.text).toContain("Paired allowFrom (store): 456");
  });

  it("adds entries to config and pairing store", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: {
        channels: { telegram: { allowFrom: ["123"] } },
      },
    });
    validateConfigObjectWithPluginsMock.mockImplementation((config: unknown) => ({
      ok: true,
      config,
    }));
    addChannelAllowFromStoreEntryMock.mockResolvedValueOnce({
      changed: true,
      allowFrom: ["123", "789"],
    });

    const cfg = {
      commands: { text: true, config: true },
      channels: { telegram: { allowFrom: ["123"] } },
    } as MoltbotConfig;
    const params = buildParams("/allowlist add dm 789", cfg);
    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: { telegram: { allowFrom: ["123", "789"] } },
      }),
    );
    expect(addChannelAllowFromStoreEntryMock).toHaveBeenCalledWith({
      channel: "telegram",
      entry: "789",
    });
    expect(result.reply?.text).toContain("DM allowlist added");
  });
});

describe("/models command", () => {
  const cfg = {
    commands: { text: true },
    agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
  } as unknown as MoltbotConfig;

  it.each(["telegram", "discord", "whatsapp"])("lists providers on %s", async (surface) => {
    const params = buildParams("/models", cfg, { Provider: surface, Surface: surface });
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Providers:");
    expect(result.reply?.text).toContain("anthropic");
    expect(result.reply?.text).toContain("Use: /models <provider>");
  });

  it("lists provider models with pagination hints", async () => {
    const params = buildParams("/models anthropic", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Models (anthropic)");
    expect(result.reply?.text).toContain("page 1/");
    expect(result.reply?.text).toContain("anthropic/claude-opus-4-5");
    expect(result.reply?.text).toContain("Switch: /model <provider/model>");
    expect(result.reply?.text).toContain("All: /models anthropic all");
  });

  it("ignores page argument when all flag is present", async () => {
    const params = buildParams("/models anthropic 3 all", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Models (anthropic)");
    expect(result.reply?.text).toContain("page 1/1");
    expect(result.reply?.text).toContain("anthropic/claude-opus-4-5");
    expect(result.reply?.text).not.toContain("Page out of range");
  });

  it("errors on out-of-range pages", async () => {
    const params = buildParams("/models anthropic 4", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Page out of range");
    expect(result.reply?.text).toContain("valid: 1-");
  });

  it("handles unknown providers", async () => {
    const params = buildParams("/models not-a-provider", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Unknown provider");
    expect(result.reply?.text).toContain("Available providers");
  });

  it("lists configured models outside the curated catalog", async () => {
    const customCfg = {
      commands: { text: true },
      agents: {
        defaults: {
          model: {
            primary: "localai/ultra-chat",
            fallbacks: ["anthropic/claude-opus-4-5"],
          },
          imageModel: "visionpro/studio-v1",
        },
      },
    } as unknown as MoltbotConfig;

    const providerList = await handleCommands(buildParams("/models", customCfg));
    expect(providerList.reply?.text).toContain("localai");
    expect(providerList.reply?.text).toContain("visionpro");

    const result = await handleCommands(buildParams("/models localai", customCfg));
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Models (localai)");
    expect(result.reply?.text).toContain("localai/ultra-chat");
    expect(result.reply?.text).not.toContain("Unknown provider");
  });
});
