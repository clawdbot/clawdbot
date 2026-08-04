/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import type { AgentsListResult, GatewayAgentRow, GatewaySessionRow } from "../api/types.ts";
import type { RouteId } from "../app-routes.ts";
import "./app-host.ts";
import type { ApplicationContext } from "./context.ts";

type ShellDocumentTitleState = {
  activeSessionKey: string;
  outboxStoreRuntime: {
    summarizeStoredChatOutboxes: () => { total: number };
  } | null;
  routeState: { routeId?: RouteId };
  runtime?: { context: ApplicationContext };
  syncDocumentTitle: () => void;
};

function roster(defaultId: string, agents: GatewayAgentRow[]): AgentsListResult {
  return { defaultId, mainKey: "main", scope: "per-sender", agents };
}

describe("OpenClaw shell document title", () => {
  function createShell(context?: ApplicationContext): ShellDocumentTitleState {
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellDocumentTitleState;
    if (context) {
      shell.runtime = { context };
    }
    return shell;
  }

  function createContext(options: {
    connected?: boolean;
    approvalCount?: number;
    agentsList?: AgentsListResult | null;
    assistantAgentId?: string;
    sessions?: GatewaySessionRow[] | null;
  }): ApplicationContext {
    return {
      gateway: {
        snapshot: {
          phase: (options.connected ?? true) ? "connected" : "reconnecting",
          assistantAgentId: options.assistantAgentId ?? null,
        },
        connection: { gatewayUrl: "ws://gateway.test" },
      },
      agents: { state: { agentsList: options.agentsList ?? null } },
      overlays: {
        snapshot: { approvalQueue: Array.from({ length: options.approvalCount ?? 0 }) },
      },
      sessions: {
        state: { result: options.sessions ? { sessions: options.sessions } : null },
      },
    } as unknown as ApplicationContext;
  }

  it("keeps the boot title before a route commits", () => {
    const shell = createShell();
    document.title = "OpenClaw Control";

    shell.routeState = {};
    shell.syncDocumentTitle();
    expect(document.title).toBe("OpenClaw Control");
  });

  it("uses the route title for a connected route", () => {
    const shell = createShell(createContext({ sessions: null }));
    shell.routeState = { routeId: "usage" };
    shell.syncDocumentTitle();
    expect(document.title).toBe("Usage — OpenClaw");
  });

  it("uses the active session's derived title for a non-main chat", () => {
    const session: GatewaySessionRow = {
      key: "agent:main:dashboard:quarterly-launch",
      kind: "direct",
      updatedAt: 1,
      derivedTitle: "Quarterly launch plan",
    };
    const shell = createShell(createContext({ sessions: [session] }));
    shell.routeState = { routeId: "chat" };
    shell.activeSessionKey = session.key;

    shell.syncDocumentTitle();

    expect(document.title).toBe("Quarterly launch plan — OpenClaw");
  });

  it("uses the agent name for an agent main chat", () => {
    const shell = createShell(
      createContext({ agentsList: roster("main", [{ id: "main", name: "Molty" }]) }),
    );
    shell.routeState = { routeId: "chat" };
    shell.activeSessionKey = "agent:main:main";

    shell.syncDocumentTitle();

    expect(document.title).toBe("Molty — OpenClaw");
  });

  it("uses the selected agent name for a global-scope main chat", () => {
    const shell = createShell(
      createContext({
        assistantAgentId: "molty",
        agentsList: roster("main", [{ id: "molty", name: "Molty" }]),
      }),
    );
    shell.routeState = { routeId: "chat" };
    shell.activeSessionKey = "global";

    shell.syncDocumentTitle();

    expect(document.title).toBe("Molty — OpenClaw");
  });

  it("falls back to the session display name when the main agent is missing", () => {
    const session: GatewaySessionRow = {
      key: "agent:missing:main",
      kind: "direct",
      updatedAt: 1,
      label: "Fallback thread",
    };
    const shell = createShell(
      createContext({ sessions: [session], agentsList: roster("main", []) }),
    );
    shell.routeState = { routeId: "chat" };
    shell.activeSessionKey = session.key;

    shell.syncDocumentTitle();

    expect(document.title).toBe("Fallback thread — OpenClaw");
  });

  it("prefixes the pending approval count", () => {
    const shell = createShell(createContext({ approvalCount: 2 }));
    shell.routeState = { routeId: "usage" };

    shell.syncDocumentTitle();

    expect(document.title).toBe("(2) Usage — OpenClaw");
  });

  it("shows offline instead of a stale approval count", () => {
    const shell = createShell(createContext({ connected: false, approvalCount: 2 }));
    shell.routeState = { routeId: "usage" };

    shell.syncDocumentTitle();

    expect(document.title).toBe("(Offline) Usage — OpenClaw");
  });

  it("includes stored chat outbox messages in the offline marker", () => {
    const shell = createShell(createContext({ connected: false }));
    shell.routeState = { routeId: "usage" };
    shell.outboxStoreRuntime = {
      summarizeStoredChatOutboxes: () => ({ total: 3 }),
    };

    shell.syncDocumentTitle();

    expect(document.title).toBe("(Offline · 3 queued) Usage — OpenClaw");
  });

  it("uses the meaningful custodian label without a brand suffix", () => {
    const shell = createShell(createContext({}));
    shell.routeState = { routeId: "custodian" };

    shell.syncDocumentTitle();

    expect(document.title).toBe("Ask OpenClaw");
  });
});
