import type { EventFrame } from "@openclaw/gateway-protocol";
import { expect, vi } from "vitest";
import { GatewaySessionMessageSubscriptionCoordinator } from "../browser.js";
import {
  createControlModel,
  type ControlModelConnectionSnapshot,
  type ControlModelConversationSnapshot,
  type ControlModelGatewayBinding,
  type ControlModelGatewayEventFrame,
  type ControlModelRequestOptions,
} from "./index.js";

type RequestCall = {
  method: string;
  params: Record<string, unknown>;
  options?: ControlModelRequestOptions;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function message(sequence: number, content = `message-${sequence}`) {
  return {
    role: sequence % 2 ? "user" : "assistant",
    content,
    __openclaw: { id: `message-${sequence}`, seq: sequence },
  };
}

export function messageIds(snapshot: ControlModelConversationSnapshot) {
  return snapshot.messages.map((entry) =>
    String((entry.raw as { __openclaw?: { id?: string } })["__openclaw"]?.id),
  );
}

export function createHarness(
  initial: ControlModelConnectionSnapshot = { status: "disconnected", epoch: 0 },
  options: {
    questions?: unknown[];
    approvalReplay?: unknown;
    history?: unknown;
    keysEquivalent?: (left: string, right: string) => boolean;
    materialize?: boolean;
  } = {},
) {
  let connection = initial;
  const connectionListeners = new Set<() => void>();
  const eventListeners = new Set<(frame: ControlModelGatewayEventFrame) => void>();
  const calls: RequestCall[] = [];
  const responses = new Map<string, unknown[]>();
  const histories = new Map<number, unknown[]>();
  const defaultHistory = options.history ?? {
    messages: [],
    completeSnapshot: true,
    totalMessages: 0,
  };

  const take = (method: string) => responses.get(method)?.shift();
  const request = vi.fn(
    async (
      method: string,
      params: Record<string, unknown>,
      requestOptions?: ControlModelRequestOptions,
    ) => {
      calls.push({ method, params, options: requestOptions });
      const queued = take(method);
      if (queued !== undefined) {
        if (queued instanceof Error) {
          throw queued;
        }
        return await Promise.resolve(queued);
      }
      if (method === "sessions.list") {
        return { sessions: [] };
      }
      if (method === "sessions.messages.subscribe") {
        return {
          key: params.key,
          ...(params.includeApprovals ? { approvalReplay: options.approvalReplay } : {}),
        };
      }
      if (method === "sessions.messages.unsubscribe") {
        return {};
      }
      if (method === "question.list") {
        return { questions: options.questions ?? [] };
      }
      if (method === "chat.history") {
        const offset = typeof params.offset === "number" ? params.offset : 0;
        return await Promise.resolve(histories.get(offset)?.shift() ?? defaultHistory);
      }
      if (method === "chat.send") {
        return { runId: "run-default", status: "accepted" };
      }
      if (method === "chat.abort") {
        return { aborted: true, runIds: typeof params.runId === "string" ? [params.runId] : [] };
      }
      if (method === "approval.resolve") {
        return { applied: true };
      }
      if (method === "question.resolve") {
        return { status: "answered" };
      }
      return {};
    },
  );
  // SAFETY: the mock implements the generic gateway request contract; callers choose the response type.
  const gatewayRequest = request as ControlModelGatewayBinding["request"];
  const materializeArtifactView = vi.fn(
    async (
      input: {
        sessionKey: string;
        agentId?: string;
        artifactId: string;
        artifactRevision: number;
        viewId: string;
      },
      requestOptions?: ControlModelRequestOptions,
    ) => {
      calls.push({ method: "artifact.materialize", params: input, options: requestOptions });
      const queued = take("artifact.materialize");
      return await Promise.resolve(queued ?? {});
    },
  );
  const createCoordinator = () =>
    new GatewaySessionMessageSubscriptionCoordinator(
      { request: gatewayRequest },
      { keysEquivalent: options.keysEquivalent },
    );
  let coordinator = createCoordinator();
  const gateway: ControlModelGatewayBinding = {
    getConnectionSnapshot: () => connection,
    subscribeConnection(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    subscribeSessionCatalogInvalidations() {
      return () => undefined;
    },
    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    getMessageSubscriptionCoordinator() {
      return coordinator;
    },
    request: gatewayRequest,
    ...(options.materialize === false ? {} : { materializeArtifactView }),
  };

  return {
    gateway,
    get coordinator() {
      return coordinator;
    },
    calls,
    request,
    materializeArtifactView,
    queue(method: string, value: unknown) {
      const queue = responses.get(method) ?? [];
      queue.push(value);
      responses.set(method, queue);
    },
    defer(method: string) {
      const pending = deferred<unknown>();
      const queue = responses.get(method) ?? [];
      queue.push(pending.promise);
      responses.set(method, queue);
      return pending;
    },
    setHistory(offset: number, ...values: unknown[]) {
      const queue = histories.get(offset) ?? [];
      queue.push(...values);
      histories.set(offset, queue);
    },
    callsFor(method: string) {
      return calls.filter((call) => call.method === method);
    },
    setConnection(next: ControlModelConnectionSnapshot, times = 1) {
      if (next.epoch !== connection.epoch) {
        coordinator.reset();
        coordinator = createCoordinator();
      }
      connection = next;
      for (let index = 0; index < times; index += 1) {
        for (const listener of connectionListeners) {
          listener();
        }
      }
    },
    pingConnection(times = 1) {
      for (let index = 0; index < times; index += 1) {
        for (const listener of connectionListeners) {
          listener();
        }
      }
    },
    emit(
      frame: Omit<ControlModelGatewayEventFrame, "connectionEpoch" | "type"> & {
        connectionEpoch?: number;
      },
    ) {
      const next = {
        type: "event" as const,
        ...frame,
        connectionEpoch: frame.connectionEpoch ?? connection.epoch,
      };
      for (const listener of eventListeners) {
        listener(next);
      }
    },
    emitProtocol(frame: EventFrame, connectionEpoch = connection.epoch) {
      for (const listener of eventListeners) {
        listener({ ...frame, connectionEpoch });
      }
    },
  };
}

export async function flush() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

export async function activatedConversation(
  harness = createHarness({ status: "connected", epoch: 1 }),
  bounds?: Parameters<typeof createControlModel>[0]["bounds"],
) {
  const model = createControlModel({
    gateway: harness.gateway,
    bounds,
    generateId: (prefix) => `${prefix}-fixed`,
  });
  model.start();
  const conversation = model.conversation("agent:main:one");
  await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(1));
  return { harness, model, conversation };
}
