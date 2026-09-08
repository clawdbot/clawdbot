import { createRouter } from "@openclaw/uirouter";
import { expect, onTestFinished, vi } from "vitest";
import type { SessionsResolveResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayEventListener } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";

const uuid = "12345678-90ab-cdef-1234-567890abcdef";
const sessionKey = `agent:roboclaw:thread:${uuid}`;

function row(overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key: sessionKey,
    kind: "direct",
    updatedAt: 1,
    displayName: "Default mode with rare surprises",
    sessionId: "fedcba98-7654-3210-fedc-ba9876543210",
    ...overrides,
  };
}

function result(sessions: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 1,
    path: "sessions.json",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function contextFor(
  resolution: SessionsResolveResult | Error = { ok: false },
  cachedSessions: GatewaySessionRow[] = [],
) {
  const router = createRouter({ routes: [] });
  const lifecycle = new AbortController();
  const gatewayListeners = new Set<Parameters<ApplicationContext["gateway"]["subscribe"]>[0]>();
  const eventListeners = new Set<GatewayEventListener>();
  onTestFinished(() => {
    lifecycle.abort();
    router.stop();
    expect(gatewayListeners.size).toBe(0);
    expect(eventListeners.size).toBe(0);
  });
  const request = vi.fn(async (method: string, _params?: unknown) => {
    if (method !== "sessions.resolve") {
      throw new Error(`Unexpected gateway request: ${method}`);
    }
    if (resolution instanceof Error) {
      throw resolution;
    }
    return resolution;
  });
  const client = { request };
  const list = vi.fn();
  const context = {
    basePath: "",
    // These tests invoke the loader directly; there is no outlet-owned match.
    router,
    lifecycleAbortSignal: lifecycle.signal,
    gateway: {
      snapshot: {
        phase: "connected",
        client,
        hello: null,
        sessionKey: "agent:roboclaw:main",
      },
      subscribe: (listener: Parameters<ApplicationContext["gateway"]["subscribe"]>[0]) => {
        gatewayListeners.add(listener);
        return () => gatewayListeners.delete(listener);
      },
      subscribeEvents: (listener: GatewayEventListener) => {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
    },
    agents: { state: { agentsList: { mainKey: "main" } } },
    agentSelection: { state: { selectedId: "roboclaw" } },
    sessions: {
      state: { result: result(cachedSessions) },
      canonicalListRevision: 0,
      list,
      whenCachedRosterSettled: async () => undefined,
    },
  } as unknown as ApplicationContext;
  return { context, list, request };
}

function installShortResolver(
  context: ApplicationContext,
  rows: GatewaySessionRow[],
  resolved: { ok: true; key: string } | { ok: false; candidates?: Array<{ key: string }> } = rows[0]
    ? { ok: true, key: rows[0].key }
    : { ok: false },
) {
  const request = vi.fn(async (method: string, _params: Record<string, unknown>) => {
    if (method === "sessions.resolve" || method === "chat.startup") {
      const present = ({ key }: { key: string }) => {
        const session = rows.find((candidate) => candidate.key === key);
        return {
          key,
          agentId: session?.agentId ?? key.split(":")[1],
          ...(session?.displayName ? { displayName: session.displayName } : {}),
          ...(session?.boardFace ? { boardFace: session.boardFace } : {}),
        };
      };
      const resolution = resolved.ok
        ? { ok: true, ...present(resolved) }
        : {
            ok: false,
            ...(resolved.candidates ? { candidates: resolved.candidates.map(present) } : {}),
          };
      return method === "chat.startup" ? { resolution, messages: [] } : resolution;
    }
    throw new Error(`Unexpected gateway request: ${method}`);
  });
  (context.gateway.snapshot.client as unknown as { request: typeof request }).request = request;
  return request;
}

// The router navigates with `options`, not the shareable `href`, so route-loader
// coverage has to start from the same location the app actually pushes.
function targetLocation(target: ReturnType<typeof sessionNavigationTarget>) {
  return { pathname: target.options.pathname, search: target.options.search ?? "", hash: "" };
}

export {
  contextFor as createSessionRouteContext,
  row as createSessionRouteRow,
  installShortResolver as installShortSessionResolver,
  result as sessionRouteListResult,
  targetLocation as sessionRouteLocation,
  sessionKey as sessionRouteKey,
  uuid as sessionRouteUuid,
};
