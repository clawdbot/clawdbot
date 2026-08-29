// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SessionCatalog,
  SessionCatalogHost,
} from "../../../packages/gateway-protocol/src/index.ts";
import { i18n } from "../i18n/index.ts";
import {
  findCatalogSessionHovercardRow,
  formatSidebarTimestamp,
  visibleCatalogHosts,
} from "./app-sidebar-session-catalogs.ts";

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

describe("findCatalogSessionHovercardRow", () => {
  it("preserves adopted naming while distinguishing repository and workspace context", () => {
    const catalogSession = (threadId: string, name: string) => ({
      threadId,
      name,
      status: "idle",
      archived: false,
      canContinue: true,
      canArchive: false,
    });
    const catalog: SessionCatalog = {
      id: "codex",
      label: "Codex",
      capabilities: { continueSession: true, archive: true },
      hosts: [
        {
          hostId: "gateway:codex",
          label: "Local Codex",
          kind: "gateway",
          connected: true,
          sessions: [
            {
              ...catalogSession("project", "Renamed upstream"),
              sessionKey: "agent:main:adopted-project",
              cwd: "/work/openclaw",
              gitBranch: "feature/hovercard",
            },
            {
              ...catalogSession("workspace", "Workspace"),
              cwd: "/work/release-notes",
            },
            {
              ...catalogSession("pull-request", "Pull request"),
              cwd: "/work/pull-request",
              pullRequest: { numbers: [125068], state: "open" },
            },
          ],
        },
      ],
    };

    expect(
      findCatalogSessionHovercardRow({
        catalogs: [catalog],
        sessionKey: "agent:main:adopted-project",
        liveRow: { label: "Operator chosen label", hasAutomation: false },
      }),
    ).toMatchObject({
      label: "Operator chosen label",
      workContext: {
        kind: "project",
        name: "openclaw",
        path: "/work/openclaw",
        branch: "feature/hovercard",
      },
    });
    expect(
      findCatalogSessionHovercardRow({
        catalogs: [catalog],
        sessionKey: "catalog:codex:gateway%3Acodex:workspace",
      })?.workContext,
    ).toEqual({ kind: "workspace", name: "release-notes", path: "/work/release-notes" });
    expect(
      findCatalogSessionHovercardRow({
        catalogs: [catalog],
        sessionKey: "catalog:codex:gateway%3Acodex:pull-request",
      })?.workContext,
    ).toEqual({ kind: "project", name: "pull-request", path: "/work/pull-request" });
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

  it("filters sessions by effective owner without inferring host identity", () => {
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

  it("uses a live adopted session owner before catalog creator provenance", () => {
    const adoptedKey = "agent:main:adopted";
    const hosts: SessionCatalogHost[] = [
      {
        hostId: "node:remote",
        label: "Remote node",
        kind: "node",
        connected: true,
        sessions: [
          {
            ...session("adopted", "Adopted"),
            sessionKey: adoptedKey,
            createdActor: { id: "operator:creator", type: "human" },
          },
        ],
      },
    ];

    expect(
      visibleCatalogHosts(hosts, "operator:owner", new Map([[adoptedKey, "operator:owner"]])),
    ).toEqual(hosts);
  });
});
