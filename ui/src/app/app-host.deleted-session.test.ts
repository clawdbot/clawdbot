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
  routeState: { routeId?: RouteId };
  didConsiderNativeRouteRestore: boolean;
  replaceChatWithCurrentSession: () => void;
  updateRouteState: (state: ReturnType<typeof selectShellRouteState>) => void;
};

const mainKey = "agent:main:main";
const deletedKey = "agent:main:deleted-thread";

function createSessionRecoveryShell(params: {
  activeSessionKey: string;
  sessionKeys: string[];
  deletedSessionKeys?: string[];
}) {
  const replace = vi.fn();
  const setSessionKey = vi.fn();
  const shell = document.createElement("openclaw-app-shell") as unknown as DeletedSessionShell;
  shell.runtime = {
    context: {
      basePath: "",
      agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
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
  resetAppHostTestGlobals();
});

describe("OpenClaw shell deleted-session recovery", () => {
  it("replaces an unresolvable session with the owning agent's main chat", () => {
    const { replace, setSessionKey, shell } = createSessionRecoveryShell({
      activeSessionKey: deletedKey,
      sessionKeys: [mainKey],
    });

    shell.replaceChatWithCurrentSession();

    expect(setSessionKey).toHaveBeenCalledExactlyOnceWith(mainKey);
    expect(replace).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/main" });
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
