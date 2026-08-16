import { expect, vi } from "vitest";
import {
  createControlModel,
  type ControlModelConnectionSnapshot,
  type ControlModelGatewayBinding,
  type ControlModelGatewayEventFrame,
  type ControlModelRequestOptions,
} from "./index.js";

export type RequestCall = {
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

export function uiArtifact(
  revision = 1,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    id: "artifact-calendar",
    revision,
    structuredContent: { title: "Team calendar" },
    views: [
      {
        id: "calendar",
        templateUri: "clawpilot://widgets/calendar",
        dataVersion: 1,
        availability: "inline",
        data: { events: [] },
      },
    ],
    state: "ready",
    source: {
      sessionKey: "agent:main:one",
      messageId: "message-2",
      toolCallId: "tool-calendar",
      toolName: "calendar",
    },
    ...overrides,
  };
}

export function messageIds(
  snapshot: ReturnType<
    ReturnType<ReturnType<typeof createControlModel>["conversation"]>["getSnapshot"]
  >,
) {
  return snapshot.messages.map((entry) =>
    // oxlint-disable-next-line no-underscore-dangle -- Canonical Gateway message metadata field.
    String((entry.raw as { __openclaw?: { id?: string } }).__openclaw?.id),
  );
}

export function createHarness(
  initial: ControlModelConnectionSnapshot = { status: "disconnected", epoch: 0 },
  options: {
    questions?: unknown[];
    approvalReplay?: unknown;
    history?: unknown;
    materialize?: boolean;
    sessionMessageKeysEquivalent?: (left: string, right: string) => boolean;
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
    ): Promise<unknown> => {
      calls.push({ method, params, options: requestOptions });
      const queued = take(method);
      if (queued !== undefined) {
        if (queued instanceof Error) {
          throw queued;
        }
        return queued;
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
        return histories.get(offset)?.shift() ?? defaultHistory;
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
  const materializeArtifactView = vi.fn(
    async (
      input: {
        sessionKey: string;
        artifactId: string;
        artifactRevision: number;
        viewId: string;
      },
      requestOptions?: ControlModelRequestOptions,
    ) => {
      calls.push({ method: "artifact.materialize", params: input, options: requestOptions });
      const queued = take("artifact.materialize");
      if (queued instanceof Error) {
        throw queued;
      }
      return await queued;
    },
  );
  const subscriptionClient = {
    request: async <T>(method: string, params: Record<string, unknown>) =>
      (await request(method, params)) as T,
  };
  const sessionMessageKeysEquivalent =
    options.sessionMessageKeysEquivalent ?? ((left: string, right: string) => left === right);
  const gateway: ControlModelGatewayBinding = {
    getSessionMessageSubscriptionClient: () => subscriptionClient,
    sessionMessageKeysEquivalent,
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
    request: async <T>(
      method: string,
      params: Record<string, unknown>,
      requestOptions?: ControlModelRequestOptions,
    ) => (await request(method, params, requestOptions)) as T,
    ...(options.materialize === false ? {} : { materializeArtifactView }),
  };

  return {
    gateway,
    subscriptionClient,
    sessionMessageKeysEquivalent,
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
      frame: Omit<ControlModelGatewayEventFrame, "connectionEpoch"> & { connectionEpoch?: number },
    ) {
      const next = { ...frame, connectionEpoch: frame.connectionEpoch ?? connection.epoch };
      for (const listener of eventListeners) {
        listener(next);
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
