/* @vitest-environment jsdom */

import type { RouteLocation, RouterState } from "@openclaw/uirouter";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouteId } from "../app-routes.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { selectShellRouteState } from "./app-host-route-state.ts";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";
import type { ApplicationContext } from "./context.ts";
import "./app-host.ts";

type DeletedSessionShell = {
  runtime: { context: ApplicationContext };
  activeSessionKey: string;
  routeState: { routeId?: RouteId; location?: RouteLocation };
  didConsiderNativeRouteRestore: boolean;
  replaceChatWithCurrentSession: () => void;
  updateRouteState: (state: ReturnType<typeof selectShellRouteState>) => void;
  observeDeletedSessions: (state: ApplicationContext["sessions"]["state"]) => void;
};

const mainKey = "agent:main:main";
const deletedKey = "agent:main:deleted-thread";

function createSessionRecoveryShell(params: {
  activeSessionKey: string;
  agentIds?: string[];
  sessionKeys: string[];
  deletedSessionKeys?: string[];
}) {
  const replace = vi.fn();
  const setSessionKey = vi.fn();
  const shell = document.createElement("openclaw-app-shell") as unknown as DeletedSessionShell;
  shell.runtime = {
    context: {
      basePath: "",
      agents: {
        state: {
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            agents: (params.agentIds ?? ["main"]).map((id) => ({ id })),
          },
        },
      },
      agentSelection: { set: vi.fn(), state: { selectedId: "main" } },
      gateway: {
        setSessionKey,
        snapshot: { client: null, hello: null, phase: "connected" },
      },
      sessions: {
        state: {
          deletedSessions: (params.deletedSessionKeys ?? []).map((key) => ({
            agentId: "main",
            key,
            retireBeforeRevision: Date.now(),
          })),
          result: { sessions: params.sessionKeys.map((key) => ({ key })) },
        },
      },
      replace,
    } as unknown as ApplicationContext,
  };
  shell.activeSessionKey = params.activeSessionKey;
  shell.routeState = { routeId: "chat" };
  return { replace, setSessionKey, shell };
}

afterEach(() => {
  document.body.replaceChildren();
  resetAppHostTestGlobals();
});

describe("OpenClaw shell deleted-session recovery", () => {
  it("retires an externally observed batch once and shows one actionable cleanup failure", async () => {
    const gatewayUrl = "ws://gateway.test";
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    storage.setItem(
      `openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayUrl)}`,
      JSON.stringify({
        version: 2,
        gatewayOwner: gatewayUrl,
        sessions: {
          [`${deletedKey}\u0000agent:main`]: {
            draft: "retire me",
            draftRevision: 1,
            queue: [{ id: "queued", text: "queued", createdAt: 1 }],
            updatedAt: 1,
          },
        },
      }),
    );
    const shell = document.createElement("openclaw-app-shell") as unknown as DeletedSessionShell;
    const deletedSessions = [
      { key: deletedKey, agentId: "main", retireBeforeRevision: Date.now() },
    ];
    const state = {
      deletedSessions,
      result: { sessions: [] },
    } as unknown as ApplicationContext["sessions"]["state"];
    shell.runtime = {
      context: {
        agents: { state: { agentsList: null } },
        gateway: {
          snapshot: {
            assistantAgentId: "main",
            client: { gatewayUrl, recoveryScopeReady: false },
            hello: null,
          },
        },
      } as unknown as ApplicationContext,
    };
    const toast = document.body.appendChild(document.createElement("openclaw-toast-host"));

    shell.observeDeletedSessions(state);
    shell.observeDeletedSessions(state);

    await vi.waitFor(() => {
      const stored = JSON.parse(
        storage.getItem(`openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayUrl)}`) ??
          "{}",
      ) as { sessions?: Record<string, { draft?: string; queue?: unknown[] }> };
      expect(stored.sessions?.[`${deletedKey}\u0000agent:main`]).toEqual({
        draftRevision: expect.any(Number),
        updatedAt: expect.any(Number),
      });
      expect(toast.textContent).toContain(
        "Session deleted, but browser draft cleanup failed. Clear this site's data to remove it.",
      );
    });
    expect(toast.querySelectorAll(".app-toast")).toHaveLength(1);
  });

  it("replaces an unresolvable session with the owning agent's main chat", () => {
    const { replace, setSessionKey, shell } = createSessionRecoveryShell({
      activeSessionKey: deletedKey,
      sessionKeys: [mainKey],
    });

    shell.replaceChatWithCurrentSession();

    expect(setSessionKey).toHaveBeenCalledExactlyOnceWith(mainKey);
    expect(replace).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/main" });
  });

  it("preserves the owning non-default agent when its session is deleted", () => {
    const researchKey = "agent:research:main";
    const { replace, setSessionKey, shell } = createSessionRecoveryShell({
      activeSessionKey: "agent:research:deleted-thread",
      agentIds: ["main", "research"],
      sessionKeys: [mainKey, researchKey],
    });

    shell.replaceChatWithCurrentSession();

    expect(setSessionKey).toHaveBeenCalledExactlyOnceWith(researchKey);
    expect(replace).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/research" });
  });

  it("recovers to a known agent when the deleted session's owner was removed", () => {
    const { replace, setSessionKey, shell } = createSessionRecoveryShell({
      activeSessionKey: "agent:retired:deleted-thread",
      agentIds: ["main"],
      sessionKeys: [mainKey],
    });

    shell.replaceChatWithCurrentSession();

    expect(setSessionKey).toHaveBeenCalledExactlyOnceWith(mainKey);
    expect(replace).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/main" });
  });

  it("does not replace a main route with the same deleted main session", () => {
    const { replace, setSessionKey, shell } = createSessionRecoveryShell({
      activeSessionKey: mainKey,
      deletedSessionKeys: [mainKey],
      sessionKeys: [mainKey],
    });

    shell.replaceChatWithCurrentSession();

    expect(setSessionKey).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("keeps a resolvable active session when a different chat route is not found", () => {
    const existingKey = "agent:main:existing-thread";
    const { replace, setSessionKey, shell } = createSessionRecoveryShell({
      activeSessionKey: existingKey,
      sessionKeys: [existingKey],
    });

    shell.replaceChatWithCurrentSession();

    expect(setSessionKey).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledExactlyOnceWith("chat", {
      pathname: "/chat/main/existing-thread",
    });
  });

  it("keeps an active session outside the filtered list when another route fails", () => {
    const existingKey = "agent:main:outside-window";
    const { replace, setSessionKey, shell } = createSessionRecoveryShell({
      activeSessionKey: existingKey,
      sessionKeys: [mainKey],
    });
    shell.routeState = {
      routeId: "chat",
      location: { pathname: "/chat/main/unrelated-missing", search: "", hash: "" },
    };

    shell.replaceChatWithCurrentSession();

    expect(setSessionKey).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledExactlyOnceWith("chat", {
      pathname: "/chat/main/outside-window",
    });
  });

  it("honors a deleted session event before its stale cached row is refreshed", () => {
    const { replace, setSessionKey, shell } = createSessionRecoveryShell({
      activeSessionKey: deletedKey,
      deletedSessionKeys: [deletedKey],
      sessionKeys: [deletedKey, mainKey],
    });

    shell.replaceChatWithCurrentSession();

    expect(setSessionKey).toHaveBeenCalledExactlyOnceWith(mainKey);
    expect(replace).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/main" });
  });

  it("rejects a late route commit for a session already marked deleted", () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const { replace, setSessionKey, shell } = createSessionRecoveryShell({
      activeSessionKey: deletedKey,
      deletedSessionKeys: [deletedKey],
      sessionKeys: [mainKey],
    });
    shell.didConsiderNativeRouteRestore = true;
    const location = {
      pathname: "/chat/main/deleted-thread",
      search: "",
      hash: "",
    } satisfies RouteLocation;
    const routerState = {
      location,
      resolvedLocation: location,
      status: "success",
      matches: [
        {
          routeId: "chat",
          location,
          data: { kind: "session", sessionKey: deletedKey },
        },
      ],
      pendingMatches: [],
      cachedMatches: [],
    } as unknown as RouterState<RouteId>;

    shell.updateRouteState(selectShellRouteState(routerState));

    expect(shell.activeSessionKey).toBe(mainKey);
    expect(setSessionKey).toHaveBeenCalledExactlyOnceWith(mainKey);
    expect(replace).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/main" });
  });
});
