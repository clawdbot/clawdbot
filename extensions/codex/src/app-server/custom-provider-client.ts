import {
  assertCodexCustomProviderEffectiveConfig,
  assertCodexCustomProviderResponse,
  assertCodexCustomProviderThreadConfig,
  CODEX_CUSTOM_PROVIDER_API_KEY_ENV,
  type CodexCustomProviderBinding,
} from "./custom-provider.js";
import { isJsonObject, type CodexServerNotification } from "./protocol.js";
import { applyCodexManagedShellEnvironment } from "./thread-shell-environment.js";

type RequestOptions = { signal?: AbortSignal; timeoutMs?: number; assertCurrent?: () => void };
type ReadRequest = (method: string, params: unknown, options: RequestOptions) => Promise<unknown>;
type PreflightErrors = {
  cancellation: (reason: "aborted" | "timed out", cause?: unknown) => Error;
  rejection: (cause: unknown) => Error;
};
export type CodexRejectedCustomProviderSession = {
  method: string;
  input: unknown;
  response: unknown;
  cause: unknown;
};
const SESSION_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);
const INFERENCE_METHODS = new Set(["turn/start", "thread/compact/start"]);
const CLEANUP_METHODS = new Set(["thread/unsubscribe", "thread/delete", "thread/archive"]);
const EXECUTION_METHODS = new Set(["command/exec", "process/spawn"]);

/** One prepared credential and route belong to one physical app-server process. */
export class CodexCustomProviderClientBinding {
  readonly binding: Readonly<CodexCustomProviderBinding>;
  private readonly selectedSessions = new Map<string, string>();

  constructor(
    binding: CodexCustomProviderBinding,
    private readonly cwd: string,
    private readonly cleanupRejectedSession: (
      session: CodexRejectedCustomProviderSession,
    ) => Promise<void>,
  ) {
    this.binding = Object.freeze({ ...binding });
  }

  handles(method: string): boolean {
    return (
      SESSION_METHODS.has(method) ||
      INFERENCE_METHODS.has(method) ||
      EXECUTION_METHODS.has(method) ||
      CLEANUP_METHODS.has(method)
    );
  }

  handleNotification(notification: CodexServerNotification): void {
    const params = notification.params;
    if (
      isJsonObject(params) &&
      typeof params.threadId === "string" &&
      (notification.method === "thread/closed" ||
        notification.method === "thread/deleted" ||
        notification.method === "thread/archived" ||
        (notification.method === "thread/status/changed" &&
          isJsonObject(params.status) &&
          params.status.type === "notLoaded"))
    ) {
      this.selectedSessions.delete(params.threadId);
    }
  }

  async request<T>(params: {
    method: string;
    input: unknown;
    options: RequestOptions;
    read: ReadRequest;
    send: (input: unknown, options: RequestOptions) => Promise<T>;
    errors: PreflightErrors;
  }): Promise<T> {
    if (CLEANUP_METHODS.has(params.method)) {
      if (isJsonObject(params.input) && typeof params.input.threadId === "string") {
        // Cleanup can take effect even if its response is lost. It must also
        // remain available when provider config no longer passes preflight.
        this.selectedSessions.delete(params.input.threadId);
      }
      return params.send(params.input, params.options);
    }
    const started = Date.now();
    const remainingOptions = () => {
      if (params.options.signal?.aborted) {
        throw params.errors.cancellation("aborted", params.options.signal.reason);
      }
      params.options.assertCurrent?.();
      const timeoutMs =
        params.options.timeoutMs === undefined
          ? undefined
          : params.options.timeoutMs - (Date.now() - started);
      if (timeoutMs !== undefined && timeoutMs <= 0) {
        throw params.errors.cancellation("timed out");
      }
      return { ...params.options, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
    };
    const prepare = async () => {
      if (!isJsonObject(params.input)) {
        throw new Error("Codex custom provider requires an explicit thread request");
      }
      const input = params.input;
      if (EXECUTION_METHODS.has(params.method) && input.env != null && !isJsonObject(input.env)) {
        throw new Error("Codex custom provider command environment must be an object");
      }
      assertCodexCustomProviderThreadConfig(input.config);
      if (
        input.approvalsReviewer === "auto_review" ||
        input.approvalsReviewer === "guardian_subagent"
      ) {
        throw new Error(
          "Custom provider workload credentials cannot authorize model-backed approval review",
        );
      }
      if (input.modelProvider != null) {
        assertCodexCustomProviderResponse(this.binding, input.modelProvider);
      }
      let cwd = typeof input.cwd === "string" ? input.cwd : this.cwd;
      if (
        INFERENCE_METHODS.has(params.method) ||
        params.method === "thread/fork" ||
        params.method === "thread/resume"
      ) {
        if (typeof input.threadId !== "string") {
          throw new Error("Codex custom provider requires an existing thread identity");
        }
        const result = await params.read(
          "thread/read",
          { threadId: input.threadId, includeTurns: false },
          remainingOptions(),
        );
        const thread =
          isJsonObject(result) && isJsonObject(result.thread) ? result.thread : undefined;
        // Resume and fork explicitly select a new provider; inference uses the current one.
        if (INFERENCE_METHODS.has(params.method)) {
          const status = isJsonObject(thread?.status) ? thread.status.type : undefined;
          const selectedSession =
            thread?.id === input.threadId &&
            typeof thread.sessionId === "string" &&
            this.selectedSessions.get(input.threadId) === thread.sessionId &&
            (status === "idle" || status === "active" || status === "systemError");
          if (!selectedSession) {
            this.selectedSessions.delete(input.threadId);
            assertCodexCustomProviderResponse(this.binding, thread?.modelProvider);
          }
        }
        if (typeof thread?.cwd === "string" && input.cwd == null) {
          cwd = thread.cwd;
        }
      }
      const effective = await params.read(
        "config/read",
        { cwd, includeLayers: true },
        remainingOptions(),
      );
      assertCodexCustomProviderEffectiveConfig(
        this.binding,
        isJsonObject(effective) ? effective.config : undefined,
      );
      let requestInput = input;
      if (SESSION_METHODS.has(params.method)) {
        requestInput = {
          ...input,
          modelProvider: this.binding.provider,
          config: {
            ...applyCodexManagedShellEnvironment(
              isJsonObject(input.config) ? input.config : {},
              { [CODEX_CUSTOM_PROVIDER_API_KEY_ENV]: "" },
              true,
            ),
            "features.shell_snapshot": false,
          },
        };
      } else if (EXECUTION_METHODS.has(params.method)) {
        requestInput = {
          ...input,
          env: {
            ...(isJsonObject(input.env) ? input.env : {}),
            [CODEX_CUSTOM_PROVIDER_API_KEY_ENV]: "",
          },
        };
      }
      return { input: requestInput, options: remainingOptions() };
    };
    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
      prepared = await prepare();
    } catch (error) {
      // Validation reads may have been written; the requested mutation has not.
      throw params.errors.rejection(error);
    }
    if (params.method === "thread/resume" && typeof prepared.input.threadId === "string") {
      this.selectedSessions.delete(prepared.input.threadId);
    }
    const result = await params.send(prepared.input, prepared.options);
    if (SESSION_METHODS.has(params.method)) {
      try {
        assertCodexCustomProviderResponse(
          this.binding,
          isJsonObject(result) ? result.modelProvider : undefined,
        );
      } catch (cause) {
        // The lifecycle caller has not received this thread's cleanup handle yet.
        await this.cleanupRejectedSession({
          method: params.method,
          input: prepared.input,
          response: result,
          cause,
        });
        throw cause;
      }
      const thread =
        isJsonObject(result) && isJsonObject(result.thread) ? result.thread : undefined;
      if (
        typeof thread?.id === "string" &&
        thread.id.trim() &&
        typeof thread.sessionId === "string" &&
        thread.sessionId.trim() &&
        (params.method !== "thread/resume" || thread.id === prepared.input.threadId) &&
        (params.method !== "thread/fork" || thread.id !== prepared.input.threadId)
      ) {
        // Codex 0.153.4 thread/read retains the creation provider after resume.
        // This client validated the active provider in the session response.
        this.selectedSessions.set(thread.id, thread.sessionId);
      }
    }
    return result;
  }
}
