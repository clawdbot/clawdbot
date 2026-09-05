import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { describe, expect, it } from "vitest";
import { resolveRunWorkspaceDir } from "../agents/workspace-run.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactToolPayloadText } from "../logging/redact.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import { getSetupAppRecommendations } from "./setup-app-recommendations.js";
import {
  completeSetupInferenceConfig,
  type CompleteSetupInferenceResult,
} from "./setup-inference.js";

const LIVE = process.env.OPENCLAW_LIVE_TEST === "1" && Boolean(process.env.OPENAI_API_KEY?.trim());
const describeLive = LIVE ? describe : describe.skip;
const modelId = process.env.OPENCLAW_LIVE_APP_RECOMMENDATIONS_MODEL ?? "gpt-5.6-luna";

const config: OpenClawConfig = {
  models: {
    providers: {
      openai: {
        api: "openai-responses",
        agentRuntime: { id: "openclaw" },
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        baseUrl: "https://api.openai.com/v1",
        models: [
          {
            id: modelId,
            name: modelId,
            api: "openai-responses",
            agentRuntime: { id: "openclaw" },
            input: ["text"],
            reasoning: true,
            contextWindow: 1_047_576,
            maxTokens: 60_000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  },
  agents: {
    // Config-injected inference bypasses load-time roster materialization.
    entries: { main: {} },
    defaults: {
      model: { primary: `openai/${modelId}` },
      models: {
        [`openai/${modelId}`]: {
          agentRuntime: { id: "openclaw" },
          params: { maxTokens: 60_000 },
        },
      },
    },
  },
};

const runtime: RuntimeEnv = {
  log: () => undefined,
  error: () => undefined,
  exit: () => undefined,
};

describe("setup app recommendations fixture", () => {
  it("admits the selected inference owner without provider credentials", async () => {
    const route = await resolveSystemAgentConfiguredRouteFromConfig(config);
    expect(route).not.toBeNull();
    expect(
      resolveRunWorkspaceDir({
        workspaceDir: undefined,
        agentId: route!.agentId,
        config: route!.runConfig,
      }).agentId,
    ).toBe("main");
  });
});

describeLive("setup app recommendations live", () => {
  it("uses real ClawHub search and OpenAI while rejecting substring traps", async () => {
    let completion: CompleteSetupInferenceResult | undefined;
    const result = await getSetupAppRecommendations({
      inventorySource: async () => [
        { label: "Notion", bundleId: "notion.id" },
        { label: "Obsidian", bundleId: "md.obsidian" },
        { label: "Slack", bundleId: "com.tinyspeck.slackmacgap" },
        { label: "1Password", bundleId: "com.agilebits.onepassword7" },
        { label: "Things", bundleId: "com.culturedcode.ThingsMac" },
        { label: "Linear", bundleId: "com.linear" },
        { label: "Zed", bundleId: "dev.zed.Zed" },
        { label: "Parallels Desktop", bundleId: "com.parallels.desktop.console" },
        { label: "ChatGPT", bundleId: "com.openai.codex" },
      ],
      runtime,
      deps: {
        complete: async (prompt) => {
          completion = await completeSetupInferenceConfig({
            config,
            prompt,
            runtime,
            timeoutMs: 240_000,
          });
          return completion;
        },
      },
    });

    const status = result.status === "ok" ? "ok" : `skipped:${result.reason}`;
    const diagnostic = truncateUtf16Safe(
      redactToolPayloadText(
        JSON.stringify(completion) ?? "Inference completion did not return a result.",
      ),
      2_000,
    );
    expect(status, `Setup inference: ${diagnostic}`).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    const matchedApps = new Set(result.matches.map((match) => match.appLabel.toLowerCase()));
    expect(matchedApps.has("notion")).toBe(true);
    expect(matchedApps.has("obsidian")).toBe(true);
    expect(matchedApps.has("slack")).toBe(true);
    const pairs = result.matches.map(
      (match) => `${match.appLabel.toLowerCase()}:${match.candidateId.toLowerCase()}`,
    );
    expect(pairs).not.toContain("linear:line");
    expect(pairs).not.toContain("zed:zededa");
    expect(pairs).not.toContain("parallels desktop:parallel");
  }, 300_000);
});
