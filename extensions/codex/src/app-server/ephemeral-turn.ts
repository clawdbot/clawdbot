import { toStringifiedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isTerminalTurnStatus, readCodexNotificationItem } from "./attempt-notifications.js";
import type { CodexAppServerClient } from "./client.js";
import { CodexUsageProjection } from "./event-projector-usage.js";
import { readCodexTurnCompletedNotification } from "./protocol-validators.js";
import { isJsonObject, type CodexThreadItem, type CodexTurn, type JsonObject } from "./protocol.js";
import { getCodexAppServerTurnRouter, type CodexThreadRouteReservation } from "./turn-router.js";

type RouteHandlers = Parameters<CodexThreadRouteReservation["activate"]>[0];

/** One ephemeral turn; the client router owns correlation, buffering and request lifetime. */
export class CodexEphemeralTurn {
  readonly route: CodexThreadRouteReservation;
  private readonly completion = createDeferred<void>();
  private readonly usage = new CodexUsageProjection();
  private readonly items = new Map<string, CodexThreadItem>();
  private readonly assistantItems = new Map<string, string>();
  private assistantText = "";
  private turn: CodexTurn | undefined;
  private error: JsonObject | undefined;

  constructor(
    client: CodexAppServerClient,
    threadId: string,
    private readonly options: RouteHandlers & {
      textMode: "last" | "all";
      onAssistantMessageStart?: () => Promise<void> | void;
    },
  ) {
    this.route = getCodexAppServerTurnRouter(client).reserveThread({
      threadId,
      ...options,
      onNotification: async (notification, scope) => {
        const params = isJsonObject(notification.params) ? notification.params : undefined;
        if (params && scope.turnId) {
          if (notification.method === "item/completed" && options.textMode === "all") {
            const item = readCodexNotificationItem(params);
            if (item) {
              this.items.set(item.id, item);
              if (item.type === "agentMessage" && item.text) {
                this.assistantItems.set(item.id, item.text);
              }
            }
          } else if (notification.method === "item/agentMessage/delta") {
            const delta = readString(params, "delta") ?? "";
            const itemId = readString(params, "itemId") ?? readString(params, "id") ?? "assistant";
            const firstDelta = !this.assistantText && Boolean(delta);
            this.assistantText += delta;
            if (delta && options.textMode === "all") {
              this.assistantItems.set(itemId, `${this.assistantItems.get(itemId) ?? ""}${delta}`);
            }
            if (firstDelta) {
              await options.onAssistantMessageStart?.();
            }
          } else if (
            notification.method === "rawResponse/completed" &&
            options.textMode === "all"
          ) {
            this.usage.record(params);
          } else if (notification.method === "turn/completed") {
            this.turn = readCodexTurnCompletedNotification(params)?.turn ?? this.turn;
            this.completion.resolve();
          } else if (notification.method === "error") {
            this.usage.invalidateContext();
            if (params.willRetry !== true) {
              this.error = params;
              this.completion.resolve();
            }
          }
        }
        await options.onNotification?.(notification, scope);
      },
    });
    // Reserve and arm synchronously before turn/start can emit requests or notifications.
    this.route.armTurn();
  }

  get completed(): boolean {
    return this.turn !== undefined;
  }

  async wait(
    turn: CodexTurn,
    options: {
      signal: AbortSignal;
      abortError: () => Error;
      timeout?: { ms: number; error: Error };
    },
  ) {
    if (isTerminalTurnStatus(turn.status)) {
      this.turn = turn;
      this.completion.resolve();
    }
    // Binding drains early notifications, including async progress callbacks;
    // its wait belongs to the same deadline and cancellation owner as completion.
    const completion = this.route
      .bindTurn(turn.id, { completed: isTerminalTurnStatus(turn.status) })
      .then(() => this.completion.promise);
    const signals = [this.route.signal, options.signal];
    const abortError = () =>
      options.signal.aborted ? options.abortError() : toStringifiedError(this.route.signal.reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    try {
      await Promise.race([
        completion,
        new Promise<never>((_resolve, reject) => {
          abort = () => {
            if (options.signal.aborted || !this.route.completed) {
              reject(abortError());
            }
          };
          // A completed route may close before projection finishes. Keep the caller's
          // later abort observable instead of consuming it through an already-fired any().
          for (const signal of signals) {
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) {
              abort();
            }
          }
          const timeout = options.timeout;
          if (timeout) {
            timer = setTimeout(() => reject(timeout.error), timeout.ms);
            timer.unref?.();
          }
        }),
      ]);
    } finally {
      clearTimeout(timer);
      for (const signal of signals) {
        signal.removeEventListener("abort", abort);
      }
    }
    const items = new Map(this.items);
    for (const item of this.turn?.items ?? []) {
      items.set(item.id, item);
    }
    // /btw has shipped last-answer semantics; bounded media/finalizer turns join all answers.
    const messages = (
      this.options.textMode === "last" ? (this.turn?.items ?? []) : [...items.values()]
    )
      .filter((item) => item.type === "agentMessage")
      .map((item) => item.text.trim())
      .filter(Boolean);
    const text =
      this.options.textMode === "last"
        ? messages.at(-1) || this.assistantText
        : messages.join("\n\n") ||
          [...this.assistantItems.values()]
            .map((message) => message.trim())
            .filter(Boolean)
            .join("\n\n");
    return {
      turn: this.turn,
      error: this.error,
      items: [...items.values()],
      text: text.trim(),
      usage: this.usage.usage,
    };
  }
}
