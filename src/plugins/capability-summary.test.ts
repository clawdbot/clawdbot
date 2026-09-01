import { describe, expect, it } from "vitest";
import type { PluginEntryConfig } from "../config/types.plugins.js";
import { buildPluginCapabilitySummary } from "./capability-summary.js";
import type { PluginManifestContracts } from "./manifest-types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

describe("plugin capability summaries", () => {
  it.each<{
    label: string;
    origin: PluginOrigin | "official";
    hooks?: PluginEntryConfig["hooks"];
    promptInjection: { effective: boolean; configured?: boolean };
    conversationAccess: { effective: boolean; configured?: boolean };
  }>([
    {
      label: "bundled defaults",
      origin: "bundled",
      promptInjection: { effective: true },
      conversationAccess: { effective: true },
    },
    {
      label: "external defaults",
      origin: "global",
      promptInjection: { effective: true },
      conversationAccess: { effective: false },
    },
    {
      label: "official catalog defaults",
      origin: "official",
      promptInjection: { effective: true },
      conversationAccess: { effective: false },
    },
    {
      label: "explicit external grants",
      origin: "workspace",
      hooks: { allowPromptInjection: false, allowConversationAccess: true },
      promptInjection: { effective: false, configured: false },
      conversationAccess: { effective: true, configured: true },
    },
    {
      label: "explicit bundled restrictions",
      origin: "bundled",
      hooks: { allowConversationAccess: false },
      promptInjection: { effective: true },
      conversationAccess: { effective: false, configured: false },
    },
  ])("preserves fail-closed policy for $label", (scenario) => {
    const summary = buildPluginCapabilitySummary({
      manifest: {},
      origin: scenario.origin,
      entryConfig: scenario.hooks ? { hooks: scenario.hooks } : undefined,
    });

    expect(summary.grants.hooks).toEqual({
      allowPromptInjection: scenario.promptInjection,
      allowConversationAccess: scenario.conversationAccess,
    });
  });

  it("normalizes manifest surfaces and configured model grants deterministically", () => {
    const summary = buildPluginCapabilitySummary({
      manifest: {
        channels: ["zeta", "alpha"],
        providers: ["zulu", "beta"],
        contracts: { tools: ["shared", "zeta-tool"] },
        toolMetadata: { "alpha-tool": {}, shared: {} },
        hooks: ["zeta-hook", "alpha-hook"],
        mcpServers: {
          zulu: { command: "zulu" },
          alpha: { command: "alpha" },
        },
        cliCommands: [
          { name: "zulu", description: "Zulu", hasSubcommands: false },
          { name: "alpha", description: "Alpha", hasSubcommands: false },
        ],
        cliBackends: ["zulu", "alpha"],
        skills: ["zulu", "alpha"],
        configContracts: {
          dangerousFlags: [
            { path: "plugins.zulu", equals: true },
            { path: "plugins.alpha", equals: true },
          ],
        },
      },
      origin: "global",
      entryConfig: {
        llm: {
          allowModelOverride: true,
          allowedModels: ["zulu/model", "alpha/model"],
          allowedCompletionModels: ["zulu/completion", "alpha/completion"],
          allowAuthProfileOverride: false,
          allowAgentIdOverride: true,
        },
        subagent: {
          allowModelOverride: false,
          allowedModels: ["zulu/model", "alpha/model"],
        },
      },
    });

    expect(summary.declared).toEqual({
      channels: ["alpha", "zeta"],
      providers: ["beta", "zulu"],
      tools: ["alpha-tool", "shared", "zeta-tool"],
      contracts: ["tools: shared", "tools: zeta-tool"],
      hooks: ["alpha-hook", "zeta-hook"],
      mcpServers: ["alpha", "zulu"],
      cliCommands: ["alpha", "zulu"],
      cliBackends: ["alpha", "zulu"],
      skills: ["alpha", "zulu"],
      dangerousConfigFlags: ["plugins.alpha", "plugins.zulu"],
    });
    expect(summary.grants.llm).toEqual({
      allowModelOverride: true,
      allowedModels: ["alpha/model", "zulu/model"],
      allowedCompletionModels: ["alpha/completion", "zulu/completion"],
      allowAuthProfileOverride: false,
      allowAgentIdOverride: true,
    });
    expect(summary.grants.subagent).toEqual({
      allowModelOverride: false,
      allowedModels: ["alpha/model", "zulu/model"],
    });
  });

  it("includes every manifest contract family in the reviewed capability surface", () => {
    const contracts = {
      embeddedExtensionFactories: ["embedded"],
      agentToolResultMiddleware: ["middleware"],
      trustedToolPolicies: ["trusted-policy"],
      externalAuthProviders: ["external-auth"],
      embeddingProviders: ["embedding"],
      speechProviders: ["speech"],
      realtimeTranscriptionProviders: ["transcription"],
      realtimeVoiceProviders: ["voice"],
      mediaUnderstandingProviders: ["media"],
      transcriptSourceProviders: ["transcript"],
      documentExtractors: ["document"],
      imageGenerationProviders: ["image"],
      videoGenerationProviders: ["video"],
      musicGenerationProviders: ["music"],
      webContentExtractors: ["web-content"],
      webFetchProviders: ["web-fetch"],
      webSearchProviders: ["web-search"],
      workerProviders: ["worker"],
      usageProviders: ["usage"],
      migrationProviders: ["migration"],
      gatewayMethodDispatch: ["gateway-method"],
      taskLaneProviders: ["task-lane"],
      tools: ["tool"],
    } satisfies Required<PluginManifestContracts>;

    const summary = buildPluginCapabilitySummary({
      manifest: { contracts },
      origin: "global",
    });

    expect(summary.declared.contracts).toEqual(
      Object.entries(contracts)
        .flatMap(([family, ids]) => ids.map((id) => `${family}: ${id}`))
        .toSorted(),
    );
  });

  it("reads channel and provider identities from official catalog manifests", () => {
    const summary = buildPluginCapabilitySummary({
      manifest: {
        channel: { id: "catalog-channel" },
        providers: [{ id: "zulu" }, {}, { id: "alpha" }],
      },
      origin: "official",
    });

    expect(summary.declared.channels).toEqual(["catalog-channel"]);
    expect(summary.declared.providers).toEqual(["alpha", "zulu"]);
  });
});
