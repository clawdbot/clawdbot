import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import {
  allowsSelectedAgent,
  GroupRouteRevalidation,
  resolveAgentId,
  resolveCreateTarget,
  routeKey,
  routeKeyFromSearch,
} from "./catalog-target.ts";
import type { NewSessionRouteData } from "./location.ts";

describe("new-session catalog target", () => {
  const agents = [{ id: "main" }, { id: "research" }];

  it("keeps the draft identity stable while target metadata resolves", () => {
    const pending = {
      agentId: "main",
      requestedAgentId: "main",
      catalogId: "claude",
      model: "",
      catalogLabel: "",
      startTerminal: false,
    };
    const ready = {
      ...pending,
      startTerminal: true,
      catalogLabel: "Claude Code",
    };

    expect(routeKey(pending)).toBe(routeKey(ready));
    expect(allowsSelectedAgent(pending, { id: "main" })).toBe(false);
    expect(allowsSelectedAgent(ready, { id: "main" })).toBe(true);
  });

  it("keeps the draft identity stable while the target agent resolves", () => {
    const requested = {
      requestedAgentId: "research",
      catalogId: "claude",
      model: "",
      catalogLabel: "",
      startTerminal: false,
    };
    const unresolved = { ...requested, agentId: "" };
    const resolved = { ...requested, agentId: "research" };

    expect(routeKey(unresolved)).toBe(routeKey(resolved));
    // Only a navigation changes the requested agent or the target.
    expect(routeKey({ ...resolved, requestedAgentId: "main" })).not.toBe(routeKey(resolved));
    expect(routeKey({ ...resolved, catalogId: "codex" })).not.toBe(routeKey(resolved));
  });

  it("derives pending draft ownership from browser route intent", () => {
    const pending = {
      agentId: "",
      requestedAgentId: "research",
      catalogId: "claude",
      model: "",
      catalogLabel: "",
      startTerminal: false,
    };

    expect(routeKeyFromSearch("?agent=research&catalog=claude")).toBe(routeKey(pending));
    expect(routeKeyFromSearch("?agent=main&catalog=claude")).not.toBe(routeKey(pending));
  });

  it("fails closed when the requested creation capability is unavailable", async () => {
    const request = vi.fn(async () => ({
      catalogs: [
        {
          id: "claude",
          label: "Claude Code",
          capabilities: { continueSession: true, archive: false },
          hosts: [],
        },
      ],
    }));

    await expect(
      resolveCreateTarget({ request } as unknown as GatewayBrowserClient, "claude", "research"),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("sessions.catalog.list", {
      agentId: "research",
      catalogId: "claude",
      limitPerHost: 1,
    });
  });

  it("resolves native terminal hosts without model-chat eligibility", async () => {
    const request = vi.fn(async () => ({
      catalogs: [
        {
          id: "claude",
          label: "Claude Code",
          capabilities: {
            continueSession: true,
            archive: false,
            startTerminal: true,
          },
          hosts: [
            {
              hostId: "node:dev",
              label: "Dev",
              kind: "node",
              connected: false,
              canStartTerminal: true,
              sessions: [],
            },
          ],
        },
      ],
    }));

    await expect(
      resolveCreateTarget({ request } as unknown as GatewayBrowserClient, "claude", "research"),
    ).resolves.toEqual({
      model: "",
      catalogLabel: "Claude Code",
      startTerminal: true,
      terminalHosts: [{ hostId: "node:dev", label: "Dev" }],
    });
  });

  it("preserves a valid requested agent for catalog-targeted sessions", () => {
    expect(
      resolveAgentId(
        {
          agentId: "research",
          catalogId: "claude",
        },
        agents,
        "main",
      ),
    ).toBe("research");
  });

  it("canonicalizes the requested agent or falls back before catalog resolution", () => {
    const target = { agentId: "Research", catalogId: "claude" };

    expect(resolveAgentId(target, agents, "main")).toBe("research");
    expect(resolveAgentId({ ...target, agentId: "retired" }, agents, "main")).toBe("main");
    expect(resolveAgentId({ ...target, agentId: "" }, agents, "research")).toBe("research");
  });

  it("reconciles a provisional new-thread picker value after the roster loads", () => {
    const location = { agentId: "main", catalogId: "" };

    expect(resolveAgentId(location, [], "main")).toBe("main");
    expect(resolveAgentId(location, [{ id: "roboclaw" }], "roboclaw")).toBe("roboclaw");
  });

  it("revalidates when a missing group reappears with empty defaults", async () => {
    let data: NewSessionRouteData = {
      agentId: "main",
      requestedAgentId: "main",
      catalogId: "",
      model: "",
      catalogLabel: "",
      startTerminal: false,
      group: "Client",
      groupStatus: "resolved",
      groupCwd: "",
      groupWorktree: false,
      groupCatalogGeneration: 1,
      groupDefaultsStatus: "ready",
    };
    const state = { groupSettings: [] as Array<{ name: string; position: number }> };
    const sessions = {
      state,
      groupsGeneration: () => 1,
      groupsStatus: () => "ready",
    } as unknown as SessionCapability;
    const revalidate = vi.fn(async () => {
      data = { ...data, groupStatus: "missing" };
    });
    const coordinator = new GroupRouteRevalidation(() => data, revalidate);

    coordinator.synchronize(sessions);
    await vi.waitFor(() => expect(revalidate).toHaveBeenCalledTimes(1));
    state.groupSettings = [{ name: "Client", position: 0 }];
    coordinator.synchronize(sessions);

    await vi.waitFor(() => expect(revalidate).toHaveBeenCalledTimes(2));
  });
});
