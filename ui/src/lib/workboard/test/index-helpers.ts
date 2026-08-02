import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { getWorkboardState } from "../runtime.ts";
import type { WorkboardCard, WorkboardTaskSummary } from "../types.ts";

type RequestHandler = (method: string, params: unknown) => unknown;
type RequestResponses = Record<string, unknown> | RequestHandler;

export type WorkboardTestClient = GatewayBrowserClient & {
  request: ReturnType<typeof vi.fn<RequestHandler>>;
};

export function createWorkboardTestClient(responses: RequestResponses): WorkboardTestClient {
  const request = vi.fn(async (method: string, params: unknown) =>
    typeof responses === "function" ? responses(method, params) : responses[method],
  );
  return { request } as unknown as WorkboardTestClient;
}

export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

export function createWorkboardCard(overrides: Partial<WorkboardCard> = {}): WorkboardCard {
  const title = overrides.title ?? "Build board";
  return {
    id: "card-1",
    title,
    status: "todo",
    priority: "normal",
    labels: [],
    position: 1000,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

export function createWorkboardExecution(
  overrides: Partial<NonNullable<WorkboardCard["execution"]>> = {},
): NonNullable<WorkboardCard["execution"]> {
  return {
    id: "exec-1",
    kind: "agent-session",
    engine: "codex",
    mode: "autonomous",
    status: "running",
    model: "openai/gpt-5.5",
    sessionKey: "agent:main:dashboard:1",
    startedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

export function createGatewaySession(
  overrides: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return {
    key: "agent:main:dashboard:1",
    kind: "direct",
    updatedAt: Date.now(),
    displayName: "Dashboard session",
    hasActiveRun: true,
    status: "running",
    ...overrides,
  };
}

export function createWorkboardTask(
  overrides: Partial<WorkboardTaskSummary> = {},
): WorkboardTaskSummary {
  const title = overrides.title ?? "Build board";
  return {
    id: "task-1",
    taskId: "task-1",
    status: "running",
    title,
    childSessionKey: "subagent:workboard-default-card-1",
    runId: "run-1",
    updatedAt: 2,
    ...overrides,
  };
}

export function createLifecycleHarness(
  host: object,
  options: {
    card?: Partial<WorkboardCard>;
    task?: Partial<WorkboardTaskSummary> | null;
    prepared?: boolean;
  } = {},
) {
  const card = createWorkboardCard({
    status: "running",
    sessionKey: "subagent:workboard-default-card-1",
    runId: "run-1",
    taskId: "task-1",
    ...options.card,
  });
  const state = getWorkboardState(host);
  state.loaded = true;
  state.cards = [card];
  const task = options.task === null ? null : createWorkboardTask(options.task);
  if (task) {
    state.tasksByCardId.set(card.id, task);
  }
  if (options.prepared) {
    state.lifecycleTasksPrepared = true;
    state.lifecycleTasksPreparedAt = Date.now();
  }
  return { state, card, task };
}
