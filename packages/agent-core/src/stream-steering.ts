import type { Message, StreamOptions, UserMessage } from "@openclaw/llm-core";
import type { AgentEventSink } from "./agent-stream-response.js";
import { getInternalSteeringQueueObserver } from "./internal-hooks.js";
import { recordRunFailure } from "./turn-interruption.js";
import type { AgentLoopConfig } from "./types.js";

/** Forward queued input while its normal transcript owner retains commit ordering. */
export function createStreamSteering(
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  convertSteering: AgentLoopConfig["convertToLlm"],
  emit: AgentEventSink,
) {
  const callWithFailureOrigin = <T>(origin: "runtime" | "provider", callback: () => T): T => {
    try {
      return callback();
    } catch (error) {
      recordRunFailure(emit, origin, error);
      throw error;
    }
  };
  const observer = getInternalSteeringQueueObserver(config.getSteeringMessages);
  let open = true;
  let cleanup: (() => void) | undefined;
  let forwarding = Promise.resolve();
  let needsContinuation: (() => boolean) | undefined;
  let finished: Promise<boolean> | undefined;
  let failure: { error: unknown } | undefined;
  let submitted = false;
  const stop = () => {
    open = false;
    const release = cleanup;
    cleanup = undefined;
    release?.();
  };
  const onActiveResponse: NonNullable<StreamOptions["onActiveResponse"]> = (control) => {
    if (!open || signal?.aborted) {
      return undefined;
    }
    // The caller can invoke provider controls from inside its callback. Observe
    // those calls first, so a provider exception keeps its origin while unwinding.
    const continuation = control.needsContinuation;
    const observedControl: typeof control = {
      steer(messages) {
        return callWithFailureOrigin("provider", () => control.steer(messages)).catch(
          (error: unknown) => {
            recordRunFailure(emit, "provider", error);
            throw error;
          },
        );
      },
      ...(continuation
        ? {
            needsContinuation: () =>
              callWithFailureOrigin("provider", () => continuation.call(control)),
          }
        : {}),
    };
    needsContinuation = observedControl.needsContinuation;
    const outerCleanup = callWithFailureOrigin("runtime", () =>
      config.onActiveResponse?.(observedControl),
    );
    const forward = () => {
      if (!open || signal?.aborted || failure || !observer || submitted) {
        return;
      }
      const messages = observer.peek();
      if (messages.length === 0) {
        return;
      }
      // One batch owns this response's continuation. Later arrivals can steer
      // its successor, without changing an already accepted context projection.
      submitted = true;
      // Reserve before conversion or network awaits: once a submission may have
      // crossed the wire, local cancellation must not claim it was withdrawn.
      const release = observer.reserve(messages);
      let dispatched = false;
      forwarding = forwarding
        .then(async () => {
          if (!open || signal?.aborted) {
            release();
            return;
          }
          let converted: Message[];
          try {
            converted = await convertSteering([...messages]);
          } catch (error) {
            recordRunFailure(emit, "runtime", error);
            throw error;
          }
          const userMessages = converted.filter(
            (message): message is UserMessage => message.role === "user",
          );
          if (
            !open ||
            signal?.aborted ||
            userMessages.length !== converted.length ||
            userMessages.length === 0
          ) {
            release();
            stop();
            return;
          }
          dispatched = true;
          if (!(await observedControl.steer(userMessages))) {
            release();
            stop();
          }
        })
        .catch((error: unknown) => {
          if (!dispatched) {
            release();
          }
          failure ??= { error };
        });
    };
    const unsubscribe = observer?.subscribe(forward);
    cleanup = () => {
      unsubscribe?.();
      callWithFailureOrigin("runtime", () => outerCleanup?.());
    };
    forward();
    return stop;
  };
  return {
    onActiveResponse,
    finish() {
      return (finished ??= (async () => {
        stop();
        await forwarding;
        if (failure) {
          throw failure.error;
        }
        return needsContinuation?.() === true;
      })());
    },
  };
}
