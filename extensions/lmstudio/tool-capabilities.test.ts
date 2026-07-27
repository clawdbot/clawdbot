import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("LM Studio configured model tool capabilities", () => {
  it.each([
    { label: "enabled", supportsTools: true },
    { label: "disabled", supportsTools: false },
    { label: "unknown", supportsTools: undefined },
  ])("preserves $label tool support during provider catalog augmentation", ({ supportsTools }) => {
    const provider = capturePluginRegistration(plugin).providers[0];
    const config = {
      models: {
        providers: {
          lmstudio: {
            models: [
              {
                id: "qwen3-8b-instruct",
                compat: {
                  ...(supportsTools === undefined ? {} : { supportsTools }),
                  supportsReasoningEffort: true,
                  supportedReasoningEfforts: ["off", "on"],
                  reasoningEffortMap: { off: "off", high: "on" },
                },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(provider?.id).toBe("lmstudio");
    expect(
      provider?.augmentModelCatalog?.({
        config,
        agentDir: "/tmp/openclaw",
        env: {},
        entries: [],
      }),
    ).toEqual([
      {
        provider: "lmstudio",
        id: "qwen3-8b-instruct",
        name: "qwen3-8b-instruct",
        compat: {
          supportsUsageInStreaming: true,
          ...(supportsTools === undefined ? {} : { supportsTools }),
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
          reasoningEffortMap: {
            off: "none",
            none: "none",
            adaptive: "xhigh",
            max: "xhigh",
          },
        },
        contextWindow: undefined,
        contextTokens: undefined,
        reasoning: undefined,
        input: undefined,
      },
    ]);
  });
});
