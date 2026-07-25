import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  allowsSelectedAgent,
  resolveAgentId,
  resolveCreateTarget,
  routeKey,
} from "./catalog-target.ts";

describe("new-session catalog target", () => {
  const agents = [{ id: "main" }, { id: "research" }];

  it("keeps the draft identity stable while target metadata resolves", () => {
    const pending = { agentId: "main", catalogId: "claude", model: "", catalogLabel: "" };
    const ready = {
      ...pending,
      model: "anthropic/claude-opus-4-8",
      catalogLabel: "Claude Code",
    };

    expect(routeKey(pending)).toBe(routeKey(ready));
    expect(allowsSelectedAgent(pending, { id: "main" })).toBe(false);
    expect(allowsSelectedAgent(ready, { id: "main" })).toBe(true);
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
});
