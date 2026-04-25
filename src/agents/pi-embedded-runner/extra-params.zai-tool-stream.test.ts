import type { Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiAiStreamSimpleMock } from "../../../test/helpers/agents/pi-ai-stream-simple-mock.js";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("@mariozechner/pi-ai", () => createPiAiStreamSimpleMock());

let runExtraParamsCase: typeof import("./extra-params.test-support.js").runExtraParamsCase;
let extraParamsTesting: typeof import("./extra-params.js").__testing;

type ToolStreamCase = {
  applyProvider: string;
  applyModelId: string;
  model: Model<"openai-completions">;
  cfg?: OpenClawConfig;
  options?: SimpleStreamOptions;
};

function runToolStreamCase(params: ToolStreamCase) {
  return runExtraParamsCase({
    applyModelId: params.applyModelId,
    applyProvider: params.applyProvider,
    cfg: params.cfg,
    model: params.model,
    options: params.options,
    payload: { model: params.model.id, messages: [] },
  }).payload as Record<string, unknown>;
}

describe("extra-params: provider tool_stream support", () => {
  beforeEach(async () => {
    ({ __testing: extraParamsTesting } = await import("./extra-params.js"));
    ({ runExtraParamsCase } = await import("./extra-params.test-support.js"));
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams: (params) => {
        const extraParams = { ...params.context.extraParams };
        if (
          (params.provider === "zai" || params.provider === "xai") &&
          extraParams.tool_stream !== false
        ) {
          extraParams.tool_stream = true;
        }
        return extraParams;
      },
      resolveProviderExtraParamsForTransport: () => undefined,
      wrapProviderStreamFn: (params) => {
        const extraParams = params.context.extraParams ?? {};
        if (extraParams.tool_stream !== true) {
          return undefined;
        }
        const inner = params.context.streamFn;
        return (model, context, options) =>
          inner?.(model, context, {
            ...options,
            onPayload(payload, payloadModel) {
              if (payload && typeof payload === "object") {
                (payload as Record<string, unknown>).tool_stream = true;
              }
              options?.onPayload?.(payload, payloadModel);
            },
          }) as ReturnType<NonNullable<typeof inner>>;
      },
    });
  });

  afterEach(() => {
    extraParamsTesting.resetProviderRuntimeDepsForTest();
  });

  it("injects tool_stream=true for zai provider by default", () => {
    const payload = runToolStreamCase({
      applyProvider: "zai",
      applyModelId: "glm-5",
      model: {
        api: "openai-completions",
        provider: "zai",
        id: "glm-5",
      } as Model<"openai-completions">,
    });

    expect(payload.tool_stream).toBe(true);
  });

  it("injects tool_stream=true for xai provider by default", () => {
    const payload = runToolStreamCase({
      applyProvider: "xai",
      applyModelId: "grok-4-1-fast-reasoning",
      model: {
        api: "openai-completions",
        provider: "xai",
        id: "grok-4-1-fast-reasoning",
      } as Model<"openai-completions">,
    });

    expect(payload.tool_stream).toBe(true);
  });

  it("does not inject tool_stream for providers that do not need it", () => {
    const payload = runToolStreamCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-5",
      } as Model<"openai-completions">,
    });

    expect(payload).not.toHaveProperty("tool_stream");
  });

  it("allows disabling zai tool_stream via params", () => {
    const payload = runToolStreamCase({
      applyProvider: "zai",
      applyModelId: "glm-5",
      model: {
        api: "openai-completions",
        provider: "zai",
        id: "glm-5",
      } as Model<"openai-completions">,
      cfg: {
        agents: {
          defaults: {
            models: {
              "zai/glm-5": {
                params: {
                  tool_stream: false,
                },
              },
            },
          },
        },
      },
    });

    expect(payload).not.toHaveProperty("tool_stream");
  });

  it("allows disabling xai tool_stream via params", () => {
    const payload = runToolStreamCase({
      applyProvider: "xai",
      applyModelId: "grok-4-1-fast-reasoning",
      model: {
        api: "openai-completions",
        provider: "xai",
        id: "grok-4-1-fast-reasoning",
      } as Model<"openai-completions">,
      cfg: {
        agents: {
          defaults: {
            models: {
              "xai/grok-4-1-fast-reasoning": {
                params: {
                  tool_stream: false,
                },
              },
            },
          },
        },
      },
    });

    expect(payload).not.toHaveProperty("tool_stream");
  });
});
