// Coverage for provider-runtime extra parameter handoff and transport filtering.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmStreamSimpleMock } from "../../../test/helpers/agents/llm-stream-simple-mock.js";
import type { Model } from "../../llm/types.js";
import {
  resolvePreparedExtraParams,
  resolveAgentTransportOverride,
  resolveExplicitSettingsTransport,
} from "./extra-params.js";
import { runExtraParamsCase, testing as extraParamsTesting } from "./extra-params.test-support.js";

vi.mock("../../llm/stream.js", () => createLlmStreamSimpleMock());

beforeEach(() => {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: ({ context }) => context.extraParams,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: ({ provider, context }) => {
      if (provider !== "local-provider" || context.thinkingLevel !== "off") {
        return context.streamFn;
      }
      // Local-provider plugin owns the exact payload spelling for thinking-off;
      // core only hands the intent through this wrapper seam.
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
  it("keeps provider-ready max stable through provider hooks and cache lookup", () => {
    const prepareProviderExtraParams = vi.fn(({ context }) => context.extraParams);
    const resolveProviderExtraParamsForTransport = vi.fn(() => undefined);
    const wrapProviderStreamFn = vi.fn(({ context }) => context.streamFn);
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams,
      resolveProviderExtraParamsForTransport,
      wrapProviderStreamFn,
    });
    const cfg = { agents: { defaults: {} } } as never;

    const first = resolvePreparedExtraParams({
      cfg,
      provider: "openai",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "max",
    });
    const repeated = resolvePreparedExtraParams({
      cfg,
      provider: "openai",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "max",
    });

    expect(first).toBe(repeated);
    expect(prepareProviderExtraParams).toHaveBeenCalledTimes(1);
    expect(resolveProviderExtraParamsForTransport).toHaveBeenCalledTimes(1);
    expect(prepareProviderExtraParams).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ thinkingLevel: "max" }) }),
    );
    expect(resolveProviderExtraParamsForTransport).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ thinkingLevel: "max" }) }),
    );

    runExtraParamsCase({
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.6-sol",
      } as unknown as Model<"openai-responses">,
      thinkingLevel: "max",
      workspaceDir: "/tmp/runtime-workspace",
      payload: { model: "gpt-5.6-sol", input: [] },
    });

    expect(wrapProviderStreamFn).toHaveBeenCalledTimes(1);
    expect(wrapProviderStreamFn.mock.calls[0]?.[0]).toMatchObject({
      workspaceDir: "/tmp/runtime-workspace",
      context: { thinkingLevel: "max", workspaceDir: "/tmp/runtime-workspace" },
    });
  });

  it("keeps unsupported upstream transport values out of OpenClaw runtime hooks", () => {
    // Upstream transports can name modes OpenClaw does not own; unresolved values
    // must be filtered before plugin runtime hooks receive them.
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

    // think must be top-level, not nested under options; provider runtimes own
    // this wire-format distinction.
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
