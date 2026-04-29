import { describe, expect, it } from "vitest";
import {
  buildQaGatewayConfig,
  DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS,
  mergeQaControlUiAllowedOrigins,
} from "./qa-gateway-config.js";
import type { QaTransportGatewayConfig } from "./qa-transport.js";

function createQaChannelTransportParams(baseUrl = "http://127.0.0.1:43124") {
  return {
    transportPluginIds: ["qa-channel"],
    transportConfig: {
      channels: {
        "qa-channel": {
          enabled: true,
          baseUrl,
          botUserId: "openclaw",
          botDisplayName: "OpenClaw QA",
          allowFrom: ["*"],
          pollTimeoutMs: 250,
        },
      },
      messages: {
        groupChat: {
          mentionPatterns: ["\\b@?openclaw\\b"],
          visibleReplies: "automatic",
        },
      },
    } satisfies QaTransportGatewayConfig,
  };
}

function getPrimaryModel(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "primary" in value) {
    const primary = (value as { primary?: unknown }).primary;
    return typeof primary === "string" ? primary : undefined;
  }
  return undefined;
}

describe("buildQaGatewayConfig", () => {
  it("keeps mock-openai as the default provider lane", () => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "token",
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      workspaceDir: "/tmp/qa-workspace",
      ...createQaChannelTransportParams(),
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("mock-openai/gpt-5.5");
    expect(cfg.models?.providers?.["mock-openai"]?.baseUrl).toBe("http://127.0.0.1:44080/v1");
    expect(cfg.models?.providers?.["mock-openai"]?.request).toEqual({ allowPrivateNetwork: true });
    expect(cfg.models?.providers?.openai?.baseUrl).toBe("http://127.0.0.1:44080/v1");
    expect(cfg.models?.providers?.openai?.request).toEqual({ allowPrivateNetwork: true });
    expect(cfg.models?.providers?.anthropic?.baseUrl).toBe("http://127.0.0.1:44080");
    expect(cfg.models?.providers?.anthropic?.request).toEqual({ allowPrivateNetwork: true });
    expect(cfg.plugins?.allow).toEqual(["acpx", "memory-core", "qa-channel"]);
    expect(cfg.plugins?.entries?.acpx).toEqual({
      enabled: true,
      config: {
        pluginToolsMcpBridge: true,
        openClawToolsMcpBridge: true,
      },
    });
    expect(cfg.plugins?.entries?.["memory-core"]).toEqual({ enabled: true });
    expect(cfg.plugins?.entries?.["qa-channel"]).toEqual({ enabled: true });
    expect(cfg.plugins?.entries?.openai).toBeUndefined();
    expect(cfg.gateway?.reload?.deferralTimeoutMs).toBe(1_000);
    expect(cfg.tools?.profile).toBe("coding");
    expect(cfg.agents?.list?.[0]?.tools?.profile).toBe("coding");
    expect(cfg.channels?.["qa-channel"]).toMatchObject({
      enabled: true,
      baseUrl: "http://127.0.0.1:43124",
      pollTimeoutMs: 250,
    });
    expect(cfg.messages?.groupChat).toMatchObject({
      mentionPatterns: ["\\b@?openclaw\\b"],
      visibleReplies: "automatic",
    });
  });

  it("maps provider-qualified openai and anthropic refs through the mock provider lane", () => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "token",
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      workspaceDir: "/tmp/qa-workspace",
      providerMode: "mock-openai",
      primaryModel: "openai/gpt-5.5",
      alternateModel: "anthropic/claude-opus-4-6",
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("openai/gpt-5.5");
    expect(cfg.models?.providers?.openai?.api).toBe("openai-responses");
    expect(cfg.models?.providers?.openai?.request).toEqual({ allowPrivateNetwork: true });
    expect(cfg.models?.providers?.openai?.models.map((model) => model.id)).toContain("gpt-5.5");
    expect(cfg.models?.providers?.anthropic?.api).toBe("anthropic-messages");
    expect(cfg.models?.providers?.anthropic?.baseUrl).toBe("http://127.0.0.1:44080");
    expect(cfg.models?.providers?.anthropic?.request).toEqual({ allowPrivateNetwork: true });
    expect(cfg.models?.providers?.anthropic?.models.map((model) => model.id)).toContain(
      "claude-opus-4-6",
    );
    expect(cfg.plugins?.allow).toEqual(["acpx", "memory-core"]);
  });

  it("falls back to provider defaults for blank model refs", () => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "token",
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      workspaceDir: "/tmp/qa-workspace",
      providerMode: "mock-openai",
      primaryModel: " ",
      alternateModel: "",
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("mock-openai/gpt-5.5");
    expect(cfg.agents?.defaults?.models).toHaveProperty("mock-openai/gpt-5.5-alt");
  });

  it("can wire AIMock as a separate mock provider lane", () => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "token",
      providerBaseUrl: "http://127.0.0.1:45080/v1",
      workspaceDir: "/tmp/qa-workspace",
      providerMode: "aimock",
      primaryModel: "aimock/gpt-5.5",
      alternateModel: "aimock/gpt-5.5-alt",
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("aimock/gpt-5.5");
    expect(cfg.agents?.defaults?.imageGenerationModel).toEqual({
      primary: "aimock/gpt-image-1",
    });
    expect(cfg.models?.providers?.aimock?.baseUrl).toBe("http://127.0.0.1:45080/v1");
    expect(cfg.models?.providers?.aimock?.api).toBe("openai-responses");
    expect(cfg.models?.providers?.openai?.baseUrl).toBe("http://127.0.0.1:45080/v1");
    expect(cfg.models?.providers?.anthropic?.baseUrl).toBe("http://127.0.0.1:45080");
    expect(cfg.models?.providers?.["mock-openai"]).toBeUndefined();
  });

  it("can omit qa-channel for live transport gateway children", () => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "token",
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      workspaceDir: "/tmp/qa-workspace",
      transportPluginIds: [],
      transportConfig: {},
    });

    expect(cfg.plugins?.allow).toEqual(["acpx", "memory-core"]);
    expect(cfg.plugins?.entries?.["qa-channel"]).toBeUndefined();
    expect(cfg.channels?.["qa-channel"]).toBeUndefined();
  });

  it("can stage extra bundled plugins in the mock lane", () => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "token",
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      workspaceDir: "/tmp/qa-workspace",
      enabledPluginIds: ["active-memory"],
      ...createQaChannelTransportParams(),
    });

    expect(cfg.plugins?.allow).toEqual(["acpx", "memory-core", "active-memory", "qa-channel"]);
    expect(cfg.plugins?.entries?.["active-memory"]).toEqual({ enabled: true });
  });

  it("uses built-in provider wiring in frontier live mode", () => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "token",
      workspaceDir: "/tmp/qa-workspace",
      providerMode: "live-frontier",
      fastMode: true,
      primaryModel: "openai/gpt-5.5",
      alternateModel: "openai/gpt-5.5",
      ...createQaChannelTransportParams(),
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("openai/gpt-5.5");
    expect(getPrimaryModel(cfg.agents?.list?.[0]?.model)).toBe("openai/gpt-5.5");
    expect(cfg.models).toBeUndefined();
    expect(cfg.plugins?.allow).toEqual(["acpx", "memory-core", "openai", "qa-channel"]);
    expect(cfg.plugins?.entries?.openai).toEqual({ enabled: true });
    expect(cfg.agents?.defaults?.models?.["openai/gpt-5.5"]).toEqual({
      params: { transport: "sse", openaiWsWarmup: false, fastMode: true },
    });
  });

  it("does not force OpenAI when the frontier lane only needs Anthropic and Google", () => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "token",
      workspaceDir: "/tmp/qa-workspace",
      providerMode: "live-frontier",
      primaryModel: "anthropic/claude-sonnet-4-6",
      alternateModel: "google/gemini-pro-test",
      imageGenerationModel: null,
      ...createQaChannelTransportParams(),
    });

    expect(cfg.plugins?.allow).toEqual([
      "acpx",
      "memory-core",
      "anthropic",
      "google",
      "qa-channel",
    ]);
    expect(cfg.plugins?.entries?.anthropic).toEqual({ enabled: true });
    expect(cfg.plugins?.entries?.google).toEqual({ enabled: true });
    expect(cfg.plugins?.entries?.openai).toBeUndefined();
    expect(cfg.agents?.defaults).not.toHaveProperty("imageGenerationModel");
  });

  it("uses owning plugin ids separately from live model provider ids", () => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "token",
      workspaceDir: "/tmp/qa-workspace",
      providerMode: "live-frontier",
      primaryModel: "codex-cli/test-model",
      alternateModel: "codex-cli/test-model",
      imageGenerationModel: null,
      enabledPluginIds: ["openai"],
      ...createQaChannelTransportParams(),
    });

    expect(getPrimaryModel(cfg.agents?.defaults?.model)).toBe("codex-cli/test-model");
    expect(cfg.plugins?.allow).toEqual(["acpx", "memory-core", "openai", "qa-channel"]);
    expect(cfg.plugins?.entries?.openai).toEqual({ enabled: true });
    expect(cfg.plugins?.entries?.["codex-cli"]).toBeUndefined();
  });

  it("merges selected live provider configs into the isolated QA config", () => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "token",
      workspaceDir: "/tmp/qa-workspace",
      providerMode: "live-frontier",
      primaryModel: "custom-openai/model-a",
      alternateModel: "custom-openai/model-a",
      imageGenerationModel: null,
      enabledPluginIds: ["openai"],
      ...createQaChannelTransportParams(),
      liveProviderConfigs: {
        "custom-openai": {
          baseUrl: "https://api.example.test/v1",
          apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          api: "openai-responses",
          models: [
            {
              id: "model-a",
              name: "model-a",
              api: "openai-responses",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4096,
            },
          ],
        },
      },
    });

    expect(cfg.models?.mode).toBe("merge");
    expect(cfg.models?.providers?.["custom-openai"]?.api).toBe("openai-responses");
    expect(cfg.plugins?.allow).toEqual(["acpx", "memory-core", "openai", "qa-channel"]);
  });

  it("can set a QA default thinking level for judge turns", () => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "token",
      workspaceDir: "/tmp/qa-workspace",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.5",
      alternateModel: "openai/gpt-5.5",
      thinkingDefault: "xhigh",
      ...createQaChannelTransportParams(),
    });

    expect(cfg.agents?.defaults?.thinkingDefault).toBe("xhigh");
    expect(cfg.agents?.defaults?.models?.["openai/gpt-5.5"]?.params).toMatchObject({
      thinking: "xhigh",
    });
  });

  it("can disable control ui for suite-only gateway children", () => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "token",
      workspaceDir: "/tmp/qa-workspace",
      controlUiEnabled: false,
      ...createQaChannelTransportParams(),
    });

    expect(cfg.gateway?.controlUi?.enabled).toBe(false);
    expect(cfg.gateway?.controlUi).not.toHaveProperty("allowInsecureAuth");
    expect(cfg.gateway?.controlUi).not.toHaveProperty("allowedOrigins");
  });

  it("pins control ui to a provided built root when available", () => {
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "token",
      workspaceDir: "/tmp/qa-workspace",
      controlUiRoot: "/tmp/openclaw/dist/control-ui",
      ...createQaChannelTransportParams(),
    });

    expect(cfg.gateway?.controlUi?.enabled).toBe(true);
    expect(cfg.gateway?.controlUi?.root).toBe("/tmp/openclaw/dist/control-ui");
  });

  it("merges dynamic qa-lab origins without dropping the built control ui root", () => {
    expect(mergeQaControlUiAllowedOrigins(["http://127.0.0.1:60196", "  "])).toEqual([
      ...DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS,
      "http://127.0.0.1:60196",
    ]);

    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "token",
      workspaceDir: "/tmp/qa-workspace",
      controlUiRoot: "/tmp/openclaw/dist/control-ui",
      controlUiAllowedOrigins: ["http://127.0.0.1:60196"],
      ...createQaChannelTransportParams(),
    });

    expect(cfg.gateway?.controlUi?.root).toBe("/tmp/openclaw/dist/control-ui");
    expect(cfg.gateway?.controlUi?.allowedOrigins).toEqual([
      ...DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS,
      "http://127.0.0.1:60196",
    ]);
  });
});
