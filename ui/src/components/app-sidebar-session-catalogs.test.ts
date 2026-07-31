// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.ts";
import { i18n } from "../i18n/index.ts";
import { formatSidebarTimestamp, visibleCatalogHosts } from "./app-sidebar-session-catalogs.ts";

describe("formatSidebarTimestamp", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await i18n.setLocale("en");
  });

  it("keeps the localized current-time label for recent sessions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T08:00:00Z"));

    expect(formatSidebarTimestamp(Date.now() - 10_000)).toBe("now");
  });

  it("uses compact localized units for older sessions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T08:00:00Z"));

    expect(formatSidebarTimestamp(Date.now() - 5 * 60_000)).toBe("5m");
  });

  it("preserves direction for timestamps in the future", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T08:00:00Z"));

    expect(formatSidebarTimestamp(Date.now() + 30_000)).toBe("in 30s");
    expect(formatSidebarTimestamp(Date.now() + 5 * 60_000)).toBe("in 5m");
  });
});

describe("visibleCatalogHosts", () => {
  const session = (threadId: string, name: string) => ({
    threadId,
    name,
    status: "idle",
    archived: false,
    canContinue: true,
    canArchive: false,
  });

  it("removes empty hosts", () => {
    const hosts: SessionCatalogHost[] = [
      {
        hostId: "gateway:local",
        label: "Gateway",
        kind: "gateway",
        connected: true,
        sessions: [session("shared", "Gateway copy")],
      },
      {
        hostId: "node:empty",
        label: "Empty node",
        kind: "node",
        connected: true,
        sessions: [],
      },
    ];

    expect(visibleCatalogHosts(hosts)).toEqual([hosts[0]]);
  });

  it("filters sessions by creator without inferring host identity", () => {
    const hosts: SessionCatalogHost[] = [
      {
        hostId: "node:remote",
        label: "Remote node",
        kind: "node",
        connected: true,
        sessions: [
          {
            ...session("mine", "Mine"),
            createdActor: { id: "operator:mine", type: "human" },
          },
          {
            ...session("theirs", "Theirs"),
            createdActor: { id: "operator:theirs", type: "human" },
          },
        ],
      },
    ];

    expect(visibleCatalogHosts(hosts, "operator:mine")).toEqual([
      { ...hosts[0]!, sessions: [hosts[0]!.sessions[0]!] },
    ]);
  });
});
