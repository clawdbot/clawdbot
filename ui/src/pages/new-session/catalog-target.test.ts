import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  allowsSelectedAgent,
  resolveAgentId,
  resolveCreateTarget,
  routeKey,
  routeKeyFromSearch,
} from "./catalog-target.ts";

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
      model: "anthropic/claude-opus-4-8",
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

  it("preserves the catalog terminal-start capability with the resolved target", async () => {
    const request = vi.fn(async () => ({
      catalogs: [
        {
          id: "claude",
          label: "Claude Code",
          capabilities: {
            continueSession: true,
            archive: false,
            createSession: {
              model: "anthropic/claude-opus-4-8",
              startTerminal: true,
            },
          },
          hosts: [],
        },
      ],
    }));

    await expect(
      resolveCreateTarget({ request } as unknown as GatewayBrowserClient, "claude", "research"),
    ).resolves.toEqual({
      model: "anthropic/claude-opus-4-8",
      catalogLabel: "Claude Code",
      startTerminal: true,
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
});
