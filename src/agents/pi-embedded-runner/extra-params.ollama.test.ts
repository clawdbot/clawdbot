import type { Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing as extraParamsTesting } from "./extra-params.js";
import { runExtraParamsCase } from "./extra-params.test-support.js";

vi.mock("@mariozechner/pi-ai", async () => {
  const original =
    await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...original,
    streamSimple: vi.fn(() => ({
      push: vi.fn(),
      result: vi.fn(),
    })),
  };
});

beforeEach(() => {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: ({ context }) => context.extraParams,
    wrapProviderStreamFn: ({ provider, context }) => {
      if (provider !== "ollama" || context.thinkingLevel !== "off") {
        return context.streamFn;
      }
      const baseStreamFn = context.streamFn;
      if (!baseStreamFn) {
        return undefined;
      }
      return (model, streamContext, options) =>
        baseStreamFn(model, streamContext, {
          ...options,
          onPayload: (payload, payloadModel) => {
            if (payload && typeof payload === "object") {
              (payload as Record<string, unknown>).think = false;
            }
            return options?.onPayload?.(payload, payloadModel);
          },
        });
    },
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

describe("extra-params: Ollama plugin handoff", () => {
  it("passes thinking-off intent through the provider runtime wrapper seam", () => {
    const payload = runExtraParamsCase({
      applyProvider: "ollama",
      applyModelId: "qwen3.5:9b",
      model: {
        api: "ollama",
        provider: "ollama",
        id: "qwen3.5:9b",
      } as unknown as Model<"openai-completions">,
      thinkingLevel: "off",
      payload: {
        model: "qwen3.5:9b",
        messages: [],
        stream: true,
        options: {
          num_ctx: 65536,
        },
      },
    }).payload as Record<string, unknown>;

    // think must be top-level, not nested under options
    expect(payload.think).toBe(false);
    expect((payload.options as Record<string, unknown>).think).toBeUndefined();
  });

  it("does not apply the plugin wrapper for non-ollama providers", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-5.4",
      } as unknown as Model<"openai-completions">,
      thinkingLevel: "off",
      payload: {
        model: "gpt-5.4",
        messages: [],
      },
    }).payload as Record<string, unknown>;

    expect(payload.think).toBeUndefined();
  });

  it("does not apply the plugin wrapper when thinkingLevel is not off", () => {
    const payload = runExtraParamsCase({
      applyProvider: "ollama",
      applyModelId: "qwen3.5:9b",
      model: {
        api: "ollama",
        provider: "ollama",
        id: "qwen3.5:9b",
      } as unknown as Model<"openai-completions">,
      thinkingLevel: "high",
      payload: {
        model: "qwen3.5:9b",
        messages: [],
        stream: true,
        options: {
          num_ctx: 65536,
        },
      },
    }).payload as Record<string, unknown>;

    expect(payload.think).toBeUndefined();
  });
});
