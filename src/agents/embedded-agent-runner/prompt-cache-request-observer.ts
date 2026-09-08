import type { StreamFn } from "../runtime/index.js";
import type { NormalizedUsage } from "../usage.js";
import {
  beginPromptCacheObservation,
  collectPromptCacheTools,
  completePromptCacheObservation,
  type PromptCacheChange,
} from "./prompt-cache-observability.js";

type PromptCacheObservationStart = ReturnType<typeof beginPromptCacheObservation>;
type PromptCacheSnapshot = PromptCacheObservationStart["snapshot"];

export type PromptCacheRequestObservation = {
  requestIndex: number;
  broke: boolean;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  previousCacheRead?: number;
  changes: PromptCacheChange[] | null;
};

/** Pairs foreground request inputs with completion usage before billing aggregation. */
export function createPromptCacheRequestObserver(
  params: Omit<
    Parameters<typeof beginPromptCacheObservation>[0],
    "provider" | "modelId" | "modelApi" | "systemPrompt" | "tools"
  >,
  onObservation: (
    observation: PromptCacheRequestObservation,
    snapshot: PromptCacheSnapshot,
  ) => void,
  onRequest?: (request: PromptCacheObservationStart & { requestIndex: number }) => void,
) {
  let requestIndex = 0;
  let request: PromptCacheObservationStart | undefined;
  let observation: PromptCacheRequestObservation | undefined;
  return {
    onModelRequest: (
      model: Pick<Parameters<StreamFn>[0], "provider" | "id" | "api">,
      context: Pick<Parameters<StreamFn>[1], "systemPrompt" | "tools">,
    ) => {
      requestIndex += 1;
      request = beginPromptCacheObservation({
        ...params,
        provider: model.provider,
        modelId: model.id,
        modelApi: model.api,
        systemPrompt: context.systemPrompt ?? "",
        tools: collectPromptCacheTools(context.tools ?? []),
      });
      onRequest?.({ ...request, requestIndex });
    },
    onModelUsage: (usage: NormalizedUsage | undefined) => {
      if (!request) {
        return;
      }
      const cacheBreak = completePromptCacheObservation({ ...params, usage });
      observation = {
        requestIndex,
        broke: Boolean(cacheBreak),
        previousCacheRead: request.previousCacheRead ?? undefined,
        input: usage?.input,
        cacheRead: usage?.cacheRead,
        cacheWrite: usage?.cacheWrite,
        changes: cacheBreak?.changes ?? request.changes,
      };
      const { snapshot } = request;
      request = undefined;
      onObservation(observation, snapshot);
    },
    getObservation: () => observation,
  };
}
