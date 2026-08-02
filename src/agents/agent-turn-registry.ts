import type { AgentEventPayload } from "../infra/agent-events.js";
import { withAgentEventSink } from "../infra/agent-events.js";

export type AgentTurnHandle<TState, TResult> = {
  readonly runId: string;
  readonly sessionKey: string;
  readonly agentId?: string;
  readonly state: TState;
  readonly signal: AbortSignal;
  readonly result: Promise<TResult>;
  cancel: (reason?: unknown) => boolean;
};

type AgentTurnSubmission<TState, TResult> = {
  runId: string;
  sessionKey: string;
  agentId?: string;
  state: TState;
  execute: (signal: AbortSignal) => Promise<TResult>;
  onEvent?: (event: AgentEventPayload) => void;
};

/**
 * Owns process-local turn handles above the model runner.
 *
 * Queue policy and presentation state stay with adapters; this registry owns
 * registration, cancellation, scoped events, and terminal cleanup.
 */
export class AgentTurnRegistry<TState, TResult> {
  private readonly active = new Map<string, AgentTurnHandle<TState, TResult>>();
  private sealed = false;

  submit(input: AgentTurnSubmission<TState, TResult>): AgentTurnHandle<TState, TResult> {
    if (this.sealed) {
      throw new Error("Agent turn registry is sealed");
    }
    if (this.active.has(input.runId)) {
      throw new Error(`Agent turn "${input.runId}" is already active`);
    }

    const controller = new AbortController();
    let resolveResult!: (value: TResult | PromiseLike<TResult>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<TResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const handle: AgentTurnHandle<TState, TResult> = {
      runId: input.runId,
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      state: input.state,
      signal: controller.signal,
      result,
      cancel: (reason) => {
        if (controller.signal.aborted) {
          return false;
        }
        controller.abort(reason);
        return true;
      },
    };
    this.active.set(input.runId, handle);

    const settle = () => {
      if (this.active.get(input.runId) === handle) {
        this.active.delete(input.runId);
      }
    };
    try {
      const execution = withAgentEventSink(
        (event) => {
          if (event.runId === input.runId && this.active.get(input.runId) === handle) {
            input.onEvent?.(event);
          }
        },
        () => input.execute(controller.signal),
      );
      void Promise.resolve(execution).then(
        (value) => {
          settle();
          resolveResult(value);
        },
        (error: unknown) => {
          settle();
          rejectResult(error);
        },
      );
    } catch (error) {
      settle();
      rejectResult(error);
    }

    return handle;
  }

  get(runId: string): AgentTurnHandle<TState, TResult> | undefined {
    return this.active.get(runId);
  }

  list(): AgentTurnHandle<TState, TResult>[] {
    return [...this.active.values()];
  }

  seal(): AgentTurnHandle<TState, TResult>[] {
    this.sealed = true;
    return this.list();
  }

  cancelAll(reason?: unknown): string[] {
    const cancelled: string[] = [];
    for (const handle of this.active.values()) {
      if (handle.cancel(reason)) {
        cancelled.push(handle.runId);
      }
    }
    return cancelled;
  }

  detachAll(reason?: unknown): AgentTurnHandle<TState, TResult>[] {
    const detached = this.list();
    this.active.clear();
    for (const handle of detached) {
      handle.cancel(reason);
    }
    return detached;
  }
}
