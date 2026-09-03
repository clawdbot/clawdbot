import {
  buildSessionObserverPrompt,
  normalizeSessionObserverModelOutput,
  SESSION_OBSERVER_MODEL_MAX_TOKENS,
  SESSION_OBSERVER_SYSTEM_PROMPT,
} from "./session-observer-model.js";
import type { SessionObserverDeps, SessionObserverState } from "./session-observer-model.js";

const MODEL_TIMEOUT_MS = 10_000;

type PrepareModel = NonNullable<SessionObserverDeps["prepareModel"]>;
type CompleteModel = NonNullable<SessionObserverDeps["completeModel"]>;

export function createSessionObserverCompletion(params: {
  getConfig: SessionObserverDeps["getConfig"];
  prepareModel: PrepareModel;
  completeModel: CompleteModel;
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
  isCurrent: (state: SessionObserverState) => boolean;
}) {
  const ensurePrepared = async (state: SessionObserverState) => {
    const modelRef = state.utilityModelRef;
    if (!modelRef) {
      throw new Error("session observer utility model is unavailable");
    }
    const preparedPromise = (state.preparedPromise ??= params.prepareModel({
      cfg: params.getConfig(),
      agentId: state.agentId,
      modelRef,
      useUtilityModel: true,
    }));
    let failed = true;
    try {
      const prepared = await preparedPromise;
      failed = false;
      return prepared;
    } finally {
      // Pending and successful preparation remain shared; settled failures do not.
      if (failed && state.preparedPromise === preparedPromise) {
        state.preparedPromise = undefined;
      }
    }
  };

  return async (state: SessionObserverState, notes: readonly string[]) => {
    const controller = new AbortController();
    state.activeController = controller;
    const timeout = params.setTimeoutFn(() => controller.abort(), MODEL_TIMEOUT_MS);
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("session observer model call timed out or was cancelled")),
        { once: true },
      );
    });
    try {
      const execute = async () => {
        const prepared = await ensurePrepared(state);
        if (!params.isCurrent(state) || controller.signal.aborted) {
          throw new Error("session observer state is no longer active");
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (!params.isCurrent(state) || controller.signal.aborted) {
            throw new Error("session observer state is no longer active");
          }
          const result = await params.completeModel({
            ...prepared,
            config: params.getConfig(),
            systemPrompt: SESSION_OBSERVER_SYSTEM_PROMPT,
            prompt: buildSessionObserverPrompt(state, notes),
            timeoutMs: MODEL_TIMEOUT_MS,
            abortSignal: controller.signal,
            streamParams: {
              maxTokens: SESSION_OBSERVER_MODEL_MAX_TOKENS,
              temperature: 0.2,
            },
          });
          const parsed = normalizeSessionObserverModelOutput(result.text);
          if (parsed) {
            return parsed;
          }
        }
        throw new Error("session observer returned invalid JSON twice");
      };
      return await Promise.race([execute(), aborted]);
    } finally {
      params.clearTimeoutFn(timeout);
      if (state.activeController === controller) {
        state.activeController = undefined;
      }
    }
  };
}
