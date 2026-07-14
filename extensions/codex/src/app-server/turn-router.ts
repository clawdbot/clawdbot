/** Keyed routing for all turn traffic on one shared Codex app-server client. */
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import {
  readCodexNotificationThreadId,
  readCodexNotificationTurnId,
} from "./notification-correlation.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type JsonValue,
  type RpcRequest,
} from "./protocol.js";

const DEFAULT_PREBIND_NOTIFICATION_LIMIT = 256;
export const CODEX_APP_SERVER_NATIVE_TURN_WAIT_TIMEOUT_MS = 30_000;

export type CodexAppServerServerRequest = Required<Pick<RpcRequest, "id" | "method">> & {
  params?: JsonValue;
};
export type CodexThreadRouteScope = {
  threadId: string;
  turnId?: string;
};
type CodexThreadRequestHandler = (
  request: CodexAppServerServerRequest,
  scope: CodexThreadRouteScope,
) => Promise<JsonValue | undefined> | JsonValue | undefined;
type CodexThreadNotificationHandler = (
  notification: CodexServerNotification,
  scope: CodexThreadRouteScope,
) => Promise<void> | void;
type CodexThreadNotificationReceivedHandler = (
  notification: CodexServerNotification,
  scope: CodexThreadRouteScope,
  receivedAtMs: number,
) => void;
type CodexThreadRouteHandlers = {
  onNotificationReceived?: CodexThreadNotificationReceivedHandler;
  onNotification?: CodexThreadNotificationHandler;
  onRequest?: CodexThreadRequestHandler;
};

export type CodexThreadRouteReservation = {
  readonly threadId: string;
  readonly signal: AbortSignal;
  activate: (handlers: CodexThreadRouteHandlers) => Promise<void>;
  armTurn: () => void;
  bindTurn: (turnId: string) => Promise<void>;
  cancelTurn: () => Promise<void>;
  waitForTurnCompletion: (options: { timeoutMs: number; signal?: AbortSignal }) => Promise<boolean>;
  drain: () => Promise<void>;
  release: () => void;
};

type RouteOptions = Partial<CodexThreadRouteHandlers> & {
  threadId: string;
  releaseOn?: AbortSignal;
};

export type CodexAppServerTurnRouter = {
  reserveThread: (options: RouteOptions) => CodexThreadRouteReservation;
  watchNativeTurnCompletion: (options: {
    threadId: string;
    turnId: string;
    timeoutMs: number;
  }) => CodexNativeTurnCompletionWatch;
};

type CodexNativeTurnCompletionWatch = {
  completion: Promise<boolean>;
  cancel: () => void;
};

type Deferred = { promise: Promise<void>; resolve: () => void };
type PendingNotification = {
  notification: CodexServerNotification;
  receivedAtMs: number;
  scope: CodexThreadRouteScope;
};
type Route = {
  threadId: string;
  controller: AbortController;
  handlers?: CodexThreadRouteHandlers;
  released?: Error;
  ended: Deferred;
  activated: Deferred;
  gate: "open" | "armed" | "bound";
  binding?: Deferred;
  turnId?: string;
  pending: PendingNotification[];
  notificationTail: Promise<void>;
  nativeTurnCompleted: boolean;
  nativeTurnCompletion?: Deferred;
  detachReleaseOn?: () => void;
};
type NativeTurnCompletionWatcher = {
  turnId: string;
  finish: (completed: boolean) => void;
  touch: () => void;
};

const routers = new WeakMap<CodexAppServerClient, ClientTurnRouter>();

/** Returns the sole router installed on a physical app-server client. */
export function getCodexAppServerTurnRouter(
  client: CodexAppServerClient,
): CodexAppServerTurnRouter {
  const existing = routers.get(client);
  if (existing) {
    return existing;
  }
  const router = new ClientTurnRouter(client);
  routers.set(client, router);
  return router;
}

class ClientTurnRouter implements CodexAppServerTurnRouter {
  private readonly routes = new Map<string, Route>();
  private readonly nativeTurnCompletionWatchers = new Map<
    string,
    Set<NativeTurnCompletionWatcher>
  >();
  private disposed = false;

  constructor(client: CodexAppServerClient) {
    client.addNotificationHandler((notification) => this.routeNotification(notification));
    client.addRequestHandler((request) => this.routeRequest(request));
    client.addCloseHandler(() => this.dispose());
  }

  reserveThread(options: RouteOptions): CodexThreadRouteReservation {
    this.assertActive();
    const threadId = requireId(options.threadId, "thread id");
    if (this.routes.has(threadId)) {
      throw new Error(`codex app-server thread route already reserved: ${threadId}`);
    }
    const route: Route = {
      threadId,
      controller: new AbortController(),
      ended: deferred(),
      activated: deferred(),
      gate: "open",
      pending: [],
      notificationTail: Promise.resolve(),
      nativeTurnCompleted: false,
    };
    this.routes.set(threadId, route);
    if (options.onNotification || options.onRequest) {
      this.activateNow(route, options);
    }
    const releaseOn = options.releaseOn;
    if (releaseOn) {
      const release = () => this.release(route, abortReason(releaseOn));
      releaseOn.addEventListener("abort", release, { once: true });
      route.detachReleaseOn = () => releaseOn.removeEventListener("abort", release);
      if (releaseOn.aborted) {
        release();
      }
    }
    return {
      threadId,
      signal: route.controller.signal,
      activate: (handlers) => this.activate(route, handlers),
      armTurn: () => this.armTurn(route),
      bindTurn: (turnId) => this.bindTurn(route, turnId),
      cancelTurn: () => this.cancelTurn(route),
      waitForTurnCompletion: (waitOptions) => this.waitForTurnCompletion(route, waitOptions),
      drain: () => this.drainNotifications(route),
      release: () => this.release(route),
    };
  }

  watchNativeTurnCompletion(options: {
    threadId: string;
    turnId: string;
    timeoutMs: number;
  }): CodexNativeTurnCompletionWatch {
    this.assertActive();
    const threadId = requireId(options.threadId, "thread id");
    const turnId = requireId(options.turnId, "turn id");
    let settle!: (completed: boolean) => void;
    const completion = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const watchers =
      this.nativeTurnCompletionWatchers.get(threadId) ?? new Set<NativeTurnCompletionWatcher>();
    this.nativeTurnCompletionWatchers.set(threadId, watchers);
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      watchers.delete(watcher);
      if (watchers.size === 0) {
        this.nativeTurnCompletionWatchers.delete(threadId);
      }
      clearTimeout(timeout);
      settle(completed);
    };
    const touch = () => {
      timeout.refresh();
    };
    const watcher = { turnId, finish, touch };
    watchers.add(watcher);
    const timeout = setTimeout(() => finish(false), Math.max(1, options.timeoutMs));
    timeout.unref?.();
    return { completion, cancel: () => finish(false) };
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const route of this.routes.values()) {
      this.release(route, new Error("codex app-server turn router closed"));
    }
    for (const watchers of this.nativeTurnCompletionWatchers.values()) {
      for (const watcher of watchers) {
        watcher.finish(false);
      }
    }
  }

  private async activate(route: Route, handlers: CodexThreadRouteHandlers): Promise<void> {
    this.assertRoute(route);
    this.activateNow(route, handlers);
    await this.waitForNotifications(route);
    this.assertRoute(route);
  }

  private activateNow(route: Route, handlers: CodexThreadRouteHandlers): void {
    if (route.handlers) {
      throw new Error(`codex app-server thread route already activated: ${route.threadId}`);
    }
    this.assertRoute(route);
    if (!handlers.onNotification && !handlers.onRequest) {
      throw new Error("codex app-server thread route requires a notification or request handler");
    }
    route.handlers = handlers;
    if (!handlers.onNotification) {
      route.pending.length = 0;
    } else if (route.gate !== "armed") {
      this.flushNotifications(route);
    }
    route.activated.resolve();
  }

  private armTurn(route: Route): void {
    this.assertRoute(route);
    if (route.gate !== "open") {
      throw new Error(`codex app-server thread route cannot arm from ${route.gate}`);
    }
    route.gate = "armed";
    route.nativeTurnCompleted = false;
    route.binding = deferred();
  }

  private async cancelTurn(route: Route): Promise<void> {
    if (route.released || route.gate !== "armed") {
      return;
    }
    route.gate = "open";
    route.binding?.resolve();
    route.binding = undefined;
    this.flushNotifications(route);
    await this.waitForNotifications(route);
    this.assertRoute(route);
  }

  private async bindTurn(route: Route, turnIdInput: string): Promise<void> {
    this.assertRoute(route);
    if (!route.handlers) {
      throw new Error("codex app-server thread route must be activated before binding a turn");
    }
    if (route.gate !== "armed") {
      throw new Error(`codex app-server thread route cannot bind from ${route.gate}`);
    }
    const turnId = requireId(turnIdInput, "turn id");
    route.gate = "bound";
    route.turnId = turnId;
    this.flushNotifications(route);
    route.binding?.resolve();
    await this.waitForNotifications(route);
    this.assertRoute(route);
  }

  // Returns the route's serialized tail so awaiting the client's notification
  // fan-out observes queued processing, not just enqueueing.
  private routeNotification(notification: CodexServerNotification): Promise<void> | undefined {
    if (this.disposed) {
      return undefined;
    }
    const scope = readScope(notification.params);
    const watchers = scope.threadId
      ? this.nativeTurnCompletionWatchers.get(scope.threadId)
      : undefined;
    const route = scope.threadId ? this.routes.get(scope.threadId) : undefined;
    if (!watchers && !route) {
      return undefined;
    }
    const terminal = isCodexTerminalTurnNotification(notification);
    if (scope.turnId && watchers) {
      for (const watcher of watchers) {
        if (watcher.turnId === scope.turnId) {
          if (terminal) {
            watcher.finish(true);
          } else {
            watcher.touch();
          }
        }
      }
    }
    if (!route) {
      return undefined;
    }
    const routeScope: CodexThreadRouteScope = {
      threadId: route.threadId,
      ...(scope.turnId ? { turnId: scope.turnId } : {}),
    };
    const receivedAtMs = Date.now();
    if (route.gate !== "bound" && terminal) {
      if (route.nativeTurnCompletion) {
        route.nativeTurnCompletion.resolve();
      } else {
        route.nativeTurnCompleted = true;
      }
    }
    if (!route.handlers) {
      this.bufferNotification(route, notification, routeScope, receivedAtMs);
      return undefined;
    }
    const handler = route.handlers.onNotification;
    if (!handler) {
      return undefined;
    }
    if (route.gate === "bound" && scope.turnId && scope.turnId !== route.turnId) {
      return undefined;
    }
    if (route.gate === "armed") {
      this.bufferNotification(route, notification, routeScope, receivedAtMs);
      return undefined;
    }
    route.handlers.onNotificationReceived?.(notification, routeScope, receivedAtMs);
    this.enqueueNotification(route, handler, notification, routeScope);
    return route.notificationTail;
  }

  private async routeRequest(request: CodexAppServerServerRequest): Promise<JsonValue | undefined> {
    if (this.disposed) {
      return undefined;
    }
    const scope = readScope(request.params);
    if (!scope.threadId) {
      return undefined;
    }
    const route = this.routes.get(scope.threadId);
    if (!route || route.released) {
      return undefined;
    }
    if (!route.handlers) {
      await route.activated.promise;
    }
    if (route.released || !route.handlers) {
      return undefined;
    }
    const handler = route.handlers.onRequest;
    if (!handler) {
      return undefined;
    }
    // Open routes service a resumed native turn. Arming starts the handoff to a
    // new OpenClaw turn, whose requests must wait for its accepted turn id.
    while (route.gate === "armed") {
      await route.binding?.promise;
      if (route.released) {
        return undefined;
      }
    }
    if (route.gate === "bound") {
      if (scope.turnId && scope.turnId !== route.turnId) {
        return undefined;
      }
      if (route.released) {
        return undefined;
      }
    }
    await this.waitForNotifications(route);
    if (route.released) {
      return undefined;
    }
    try {
      const result = await handler(request, {
        threadId: scope.threadId,
        ...(scope.turnId ? { turnId: scope.turnId } : {}),
      });
      return route.released ? undefined : result;
    } catch (error) {
      if (route.released) {
        return undefined;
      }
      throw error;
    }
  }

  private flushNotifications(route: Route): void {
    const handler = route.handlers?.onNotification;
    if (!handler) {
      return;
    }
    for (const pending of route.pending.splice(0)) {
      if (
        !pending.scope.turnId ||
        route.gate !== "bound" ||
        pending.scope.turnId === route.turnId
      ) {
        route.handlers?.onNotificationReceived?.(
          pending.notification,
          pending.scope,
          pending.receivedAtMs,
        );
        this.enqueueNotification(route, handler, pending.notification, pending.scope);
      }
    }
  }

  private bufferNotification(
    route: Route,
    notification: CodexServerNotification,
    scope: CodexThreadRouteScope,
    receivedAtMs: number,
  ): void {
    if (route.pending.length < DEFAULT_PREBIND_NOTIFICATION_LIMIT) {
      route.pending.push({ notification, receivedAtMs, scope });
      return;
    }
    const error = new Error(
      `codex app-server pre-bind notification buffer exceeded ${DEFAULT_PREBIND_NOTIFICATION_LIMIT} entries for thread ${route.threadId}`,
    );
    embeddedAgentLog.warn(error.message);
    this.release(route, error);
  }

  private enqueueNotification(
    route: Route,
    handler: CodexThreadNotificationHandler,
    notification: CodexServerNotification,
    scope: CodexThreadRouteScope,
  ): void {
    if (route.released) {
      return;
    }
    route.notificationTail = route.notificationTail
      .then(() => handler(notification, scope))
      .catch((error: unknown) => {
        if (!route.released) {
          embeddedAgentLog.warn("codex app-server keyed notification handler failed", {
            method: notification.method,
            threadId: route.threadId,
            turnId: route.turnId,
            error,
          });
        }
      });
  }

  private async waitForNotifications(route: Route): Promise<void> {
    await Promise.race([route.notificationTail, route.ended.promise]);
  }

  private async drainNotifications(route: Route): Promise<void> {
    await route.notificationTail;
  }

  private async waitForTurnCompletion(
    route: Route,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<boolean> {
    this.assertRoute(route);
    if (route.nativeTurnCompleted) {
      route.nativeTurnCompleted = false;
      return true;
    }
    if (route.nativeTurnCompletion) {
      throw new Error(`codex app-server turn completion wait already active: ${route.threadId}`);
    }
    const completion = deferred();
    route.nativeTurnCompletion = completion;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeAbort: (() => void) | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), Math.max(1, options.timeoutMs));
    });
    const aborted = new Promise<boolean>((resolve) => {
      const signal = options.signal;
      if (!signal) {
        return;
      }
      const onAbort = () => resolve(false);
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        onAbort();
      }
    });
    try {
      return await Promise.race([
        completion.promise.then(() => true),
        route.ended.promise.then(() => false),
        timedOut,
        aborted,
      ]);
    } finally {
      if (route.nativeTurnCompletion === completion) {
        route.nativeTurnCompletion = undefined;
      }
      if (timeout) {
        clearTimeout(timeout);
      }
      removeAbort?.();
    }
  }

  private release(route: Route, error = new Error("codex app-server thread route is released")) {
    if (route.released) {
      return;
    }
    route.released = error;
    route.pending.length = 0;
    route.ended.resolve();
    route.activated.resolve();
    route.binding?.resolve();
    route.detachReleaseOn?.();
    route.controller.abort(error);
    if (this.routes.get(route.threadId) === route) {
      this.routes.delete(route.threadId);
    }
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("codex app-server turn router is closed");
    }
  }

  private assertRoute(route: Route): void {
    if (route.released) {
      throw route.released;
    }
  }
}

/** True after Codex will not continue the exact turn. */
function isCodexTerminalTurnNotification(notification: CodexServerNotification): boolean {
  if (notification.method === "turn/completed") {
    return true;
  }
  return (
    notification.method === "error" &&
    isJsonObject(notification.params) &&
    notification.params.willRetry === false
  );
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason ?? "codex app-server thread route aborted"));
}

function readScope(value: JsonValue | undefined) {
  if (!isJsonObject(value)) {
    return {};
  }
  const threadId = readCodexNotificationThreadId(value);
  const turnId = readCodexNotificationTurnId(value);
  return { ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}) };
}

function requireId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`codex app-server ${label} must not be empty`);
  }
  return normalized;
}
