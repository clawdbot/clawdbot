import type { Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiAiStreamSimpleMock } from "../../../test/helpers/agents/pi-ai-stream-simple-mock.js";
import { __testing as extraParamsTesting } from "./extra-params.js";
import { runExtraParamsCase } from "./extra-params.test-support.js";

vi.mock("@earendil-works/pi-ai", () => createPiAiStreamSimpleMock());

beforeEach(() => {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: (params) => params.context.extraParams,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: () => undefined,
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

function runGoogleExtraParamsCase(params?: { cfg?: unknown }) {
  return runExtraParamsCase({
    ...(params?.cfg ? { cfg: params.cfg as never } : {}),
    applyProvider: "google",
    applyModelId: "gemini-2.5-pro",
    model: {
      api: "google-generative-ai",
      provider: "google",
      id: "gemini-2.5-pro",
    } as unknown as Model<"openai-completions">,
    payload: {
      contents: [],
    },
  });
}

describe("extra-params: Google thinking payload compatibility", () => {
  it("strips negative thinking budgets and fills Gemini 3.1 thinkingLevel", () => {
    const payload = runExtraParamsCase({
      applyProvider: "google",
      applyModelId: "gemini-3.1-pro-preview",
      model: {
        api: "google-generative-ai",
        provider: "google",
        id: "gemini-3.1-pro-preview",
      } as unknown as Model<"openai-completions">,
      thinkingLevel: "high",
      payload: {
        contents: [],
        config: {
          thinkingConfig: {
            thinkingBudget: -1,
          },
        },
      },
    }).payload as {
      config?: {
        thinkingConfig?: Record<string, unknown>;
      };
    };

    expect(payload.config?.thinkingConfig?.thinkingBudget).toBeUndefined();
    expect(payload.config?.thinkingConfig?.thinkingLevel).toBe("HIGH");
  });

  it("passes cachedContent through Google extra params", () => {
    const { options } = runGoogleExtraParamsCase({
      cfg: {
        agents: {
          defaults: {
            models: {
              "google/gemini-2.5-pro": {
                params: {
                  cachedContent: "cachedContents/test-cache",
                },
              },
            },
          },
        },
      },
    });

    expect((options as { cachedContent?: string } | undefined)?.cachedContent).toBe(
      "cachedContents/test-cache",
    );
  });

  it("lets higher-precedence cachedContent override lower-precedence cached_content", () => {
    const { options } = runGoogleExtraParamsCase({
      cfg: {
        agents: {
          defaults: {
            params: {
              cached_content: "cachedContents/default-cache",
            },
            models: {
              "google/gemini-2.5-pro": {
                params: {
                  cachedContent: "cachedContents/model-cache",
                },
              },
            },
          },
        },
      },
    });

    expect((options as { cachedContent?: string } | undefined)?.cachedContent).toBe(
      "cachedContents/model-cache",
    );
  });
});
