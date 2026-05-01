import type { Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiAiStreamSimpleMock } from "../../../test/helpers/agents/pi-ai-stream-simple-mock.js";
import {
  __testing as extraParamsTesting,
  resolveAgentTransportOverride,
  resolveExplicitSettingsTransport,
} from "./extra-params.js";
import { runExtraParamsCase } from "./extra-params.test-support.js";

vi.mock("@mariozechner/pi-ai", () => createPiAiStreamSimpleMock());

beforeEach(() => {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: ({ context }) => context.extraParams,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: ({ provider, context }) => {
      if (provider !== "local-provider" || context.thinkingLevel !== "off") {
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

describe("extra-params: provider runtime handoff", () => {
  it("keeps unsupported upstream transport values out of OpenClaw runtime hooks", () => {
    const settingsManager = {
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({}),
    };

    expect(
      resolveAgentTransportOverride({
        settingsManager,
        effectiveExtraParams: { transport: "websocket-cached" },
      }),
    ).toBeUndefined();
    expect(
      resolveExplicitSettingsTransport({
        settingsManager: {
          getGlobalSettings: () => ({ transport: "auto" }),
          getProjectSettings: () => ({}),
        },
        sessionTransport: "websocket-cached",
      }),
    ).toBeUndefined();
  });

  it("passes thinking-off intent through the provider runtime wrapper seam", () => {
    const payload = runExtraParamsCase({
      applyProvider: "local-provider",
      applyModelId: "local-model:9b",
      model: {
        api: "openai-completions",
        provider: "local-provider",
        id: "local-model:9b",
      } as unknown as Model<"openai-completions">,
      thinkingLevel: "off",
      payload: {
        model: "local-model:9b",
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

  it("does not apply the plugin wrapper for other providers", () => {
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
      applyProvider: "local-provider",
      applyModelId: "local-model:9b",
      model: {
        api: "openai-completions",
        provider: "local-provider",
        id: "local-model:9b",
      } as unknown as Model<"openai-completions">,
      thinkingLevel: "high",
      payload: {
        model: "local-model:9b",
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
