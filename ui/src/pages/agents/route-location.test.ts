// @vitest-environment node
import type { RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it } from "vitest";
import { resolveAgentsRouteLocation } from "./route-location.ts";

function location(url: string): RouteLocation {
  const parsed = new URL(url, "https://control.test");
  return { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash };
}

describe("Agents route location", () => {
  it.each([
    ["/settings/agents", null, "files"],
    ["/settings/agents/research", "research", "files"],
    ["/settings/agents/research/overview", "research", "overview"],
    ["/settings/agents/research/files", "research", "files"],
    ["/settings/agents/research/tools", "research", "tools"],
    ["/settings/agents/research/skills", "research", "skills"],
    ["/settings/agents/research/channels", "research", "channels"],
    ["/settings/agents/research/cron", "research", "cron"],
    ["/settings/agents/research/memory", "research", "memory"],
  ] as const)("reads %s without rewriting it", (url, requestedAgentId, panel) => {
    expect(resolveAgentsRouteLocation(location(url))).toMatchObject({
      requestedAgentId,
      panel,
      location: location(url),
    });
    expect(resolveAgentsRouteLocation(location(url)).canonicalLocation).toBeUndefined();
  });

  it("normalizes a legacy agent query once and preserves other URL state", () => {
    expect(
      resolveAgentsRouteLocation(location("/settings/agents?agent=team.writer&probe=1#catalog")),
    ).toEqual({
      location: location("/settings/agents?agent=team.writer&probe=1#catalog"),
      requestedAgentId: "team.writer",
      panel: "files",
      canonicalLocation: location("/settings/agents/team%2Ewriter?probe=1#catalog"),
    });
  });

  it("prefers a canonical path over a stale legacy query", () => {
    expect(
      resolveAgentsRouteLocation(location("/settings/agents/research/tools?agent=main&probe=1")),
    ).toEqual({
      location: location("/settings/agents/research/tools?agent=main&probe=1"),
      requestedAgentId: "research",
      panel: "tools",
      canonicalLocation: location("/settings/agents/research/tools?probe=1"),
    });
  });

  it("normalizes an unknown panel to the agent default panel path", () => {
    expect(
      resolveAgentsRouteLocation(
        location("/ui/settings/agents/research/unknown?probe=1#files"),
        "/ui",
      ),
    ).toEqual({
      location: location("/ui/settings/agents/research/unknown?probe=1#files"),
      requestedAgentId: "research",
      panel: "files",
      canonicalLocation: location("/ui/settings/agents/research?probe=1#files"),
    });
  });

  it("drops a legacy slash-containing agent id to the bare route", () => {
    expect(resolveAgentsRouteLocation(location("/settings/agents?agent=team%2Fwriter"))).toEqual({
      location: location("/settings/agents?agent=team%2Fwriter"),
      requestedAgentId: null,
      panel: "files",
      canonicalLocation: location("/settings/agents"),
    });
  });

  it.each([".", ".."])('drops the legacy dot-segment agent id "%s"', (agentId) => {
    expect(
      resolveAgentsRouteLocation(location(`/settings/agents?agent=${encodeURIComponent(agentId)}`)),
    ).toEqual({
      location: location(`/settings/agents?agent=${encodeURIComponent(agentId)}`),
      requestedAgentId: null,
      panel: "files",
      canonicalLocation: location("/settings/agents"),
    });
  });

  it("recovers the dynamic pathname without leaking the internal router parameter", () => {
    expect(
      resolveAgentsRouteLocation(
        location(
          "/settings/agents?__openclawAgentPath=%2Fsettings%2Fagents%2Fresearch%2Fmemory&probe=1",
        ),
      ),
    ).toEqual({
      location: location("/settings/agents/research/memory?probe=1"),
      requestedAgentId: "research",
      panel: "memory",
    });
  });
});
