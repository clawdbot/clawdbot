import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";

import type { ClawdbotConfig } from "../../config/config.js";
import { log } from "./logger.js";

/**
 * Resolve provider-specific extraParams from model config.
 * Auto-enables thinking mode for GLM-4.x models unless explicitly disabled.
 *
 * For ZAI GLM-4.x models, we auto-enable thinking via the Z.AI Cloud API format:
 *   thinking: { type: "enabled", clear_thinking: boolean }
 *
 * - GLM-4.7: Preserved thinking (clear_thinking: false) - reasoning kept across turns
 * - GLM-4.5/4.6: Interleaved thinking (clear_thinking: true) - reasoning cleared each turn
 *
 * Users can override via config:
 *   agents.defaults.models["zai/glm-4.7"].params.thinking = { type: "disabled" }
 *
 * Or disable via runtime flag: --thinking off
 *
 * @see https://docs.z.ai/guides/capabilities/thinking-mode
 * @internal Exported for testing only
 */
export function resolveExtraParams(params: {
  cfg: ClawdbotConfig | undefined;
  provider: string;
  modelId: string;
  thinkLevel?: string;
}): Record<string, unknown> | undefined {
  const modelKey = `${params.provider}/${params.modelId}`;
  const modelConfig = params.cfg?.agents?.defaults?.models?.[modelKey];
  let extraParams = modelConfig?.params ? { ...modelConfig.params } : undefined;

  // Auto-enable thinking for ZAI GLM-4.x models when not explicitly configured
  // Skip if user explicitly disabled thinking via --thinking off
  if (params.provider === "zai" && params.thinkLevel !== "off") {
    const modelIdLower = params.modelId.toLowerCase();
    const isGlm4 = modelIdLower.includes("glm-4");

    if (isGlm4) {
      const hasThinkingConfig = extraParams?.thinking !== undefined;
      if (!hasThinkingConfig) {
        // GLM-4.7 supports preserved thinking; GLM-4.5/4.6 clear each turn.
        const isGlm47 = modelIdLower.includes("glm-4.7");
        const clearThinking = !isGlm47;

        extraParams = {
          ...extraParams,
          thinking: {
            type: "enabled",
            clear_thinking: clearThinking,
          },
        };

        log.debug(
          `auto-enabled thinking for ${modelKey}: type=enabled, clear_thinking=${clearThinking}`,
        );
      }
    }
  }

  return extraParams;
}

function createStreamFnWithExtraParams(
  baseStreamFn: StreamFn | undefined,
  extraParams: Record<string, unknown> | undefined,
): StreamFn | undefined {
  if (!extraParams || Object.keys(extraParams).length === 0) {
    return undefined;
  }

  const streamParams: Partial<SimpleStreamOptions> = {};
  if (typeof extraParams.temperature === "number") {
    streamParams.temperature = extraParams.temperature;
  }
  if (typeof extraParams.maxTokens === "number") {
    streamParams.maxTokens = extraParams.maxTokens;
  }

  if (Object.keys(streamParams).length === 0) {
    return undefined;
  }

  log.debug(
    `creating streamFn wrapper with params: ${JSON.stringify(streamParams)}`,
  );

  const underlying = baseStreamFn ?? streamSimple;
  const wrappedStreamFn: StreamFn = (model, context, options) =>
    underlying(model as Model<Api>, context, {
      ...streamParams,
      ...options,
    });

  return wrappedStreamFn;
}

/**
 * Apply extra params (like temperature) to an agent's streamFn.
 *
 * @internal Exported for testing
 */
export function applyExtraParamsToAgent(
  agent: { streamFn?: StreamFn },
  cfg: ClawdbotConfig | undefined,
  provider: string,
  modelId: string,
  thinkLevel?: string,
): void {
  const extraParams = resolveExtraParams({
    cfg,
    provider,
    modelId,
    thinkLevel,
  });
  const wrappedStreamFn = createStreamFnWithExtraParams(
    agent.streamFn,
    extraParams,
  );

  if (wrappedStreamFn) {
    log.debug(
      `applying extraParams to agent streamFn for ${provider}/${modelId}`,
    );
    agent.streamFn = wrappedStreamFn;
  }
}
