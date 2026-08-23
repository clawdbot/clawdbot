import { expect, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import { taskSuggestionsHandlers } from "./task-suggestions.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

type Method =
  | "taskSuggestions.list"
  | "taskSuggestions.create"
  | "taskSuggestions.accept"
  | "taskSuggestions.dismiss";

export const GIT_CWD = process.cwd();
export const SOURCE_SESSION_KEY = "agent:main:source";

export async function call(
  method: Method,
  params: Record<string, unknown>,
  broadcast = vi.fn(),
  overrides: Record<string, unknown> & {
    client?: GatewayClient | null;
    context?: Partial<GatewayRequestContext>;
    config?: Record<string, unknown>;
  } = {},
) {
  const calls: Parameters<RespondFn>[] = [];
  const config =
    overrides.config ??
    (overrides.client !== undefined || overrides.context !== undefined ? {} : overrides);
  await taskSuggestionsHandlers[method]?.({
    req: { type: "req", id: "request-1", method, params },
    params,
    respond: (...args: Parameters<RespondFn>) => calls.push(args),
    client: overrides.client ?? null,
    isWebchatConnect: () => true,
    context: { broadcast, getRuntimeConfig: () => config, ...overrides.context },
  } as never);
  return { response: calls[0], broadcast };
}

export function requirePayload(result: Awaited<ReturnType<typeof call>>): unknown {
  expect(result.response?.[0]).toBe(true);
  if (!result.response?.[0]) {
    throw new Error("expected a successful gateway response");
  }
  return result.response[1];
}

export async function dismissPendingTaskSuggestions(): Promise<void> {
  const listed = await call("taskSuggestions.list", {});
  const payload = requirePayload(listed) as { suggestions: Array<{ id: string }> };
  for (const suggestion of payload.suggestions) {
    await call("taskSuggestions.dismiss", { taskId: suggestion.id });
  }
}

export function operatorClient(): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.admin"],
      caps: [GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS],
    },
  };
}

export function configuredCloudContext(
  profiles: Record<string, { provider: string }> = { primary: { provider: "test" } },
): Partial<GatewayRequestContext> {
  return {
    workerEnvironmentService: {} as never,
    workerPlacementDispatchService: {} as never,
    getRuntimeConfig: () => ({ cloudWorkers: { profiles } }),
  };
}

export async function createSourceSuggestion() {
  const created = await call("taskSuggestions.create", {
    title: "Fix the source session",
    prompt: "Apply the focused fix in this session.",
    tldr: "The current session already owns the relevant context.",
    cwd: GIT_CWD,
    sessionKey: SOURCE_SESSION_KEY,
    agentId: "main",
  });
  return (requirePayload(created) as { taskId: string }).taskId;
}

export async function createLocalTaskSuggestion() {
  const created = await call("taskSuggestions.create", {
    title: "Add coverage",
    prompt: "Add the missing regression test.",
    tldr: "The edge case is untested.",
    cwd: GIT_CWD,
    sessionKey: "agent:main:main",
    agentId: "main",
  });
  return (requirePayload(created) as { taskId: string }).taskId;
}
