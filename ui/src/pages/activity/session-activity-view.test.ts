/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { PresenceViewer } from "../../lib/presence-users.ts";
import { renderSessionActivityView } from "./session-activity-view.ts";

function row(
  key: string,
  owner: { id: string; label?: string },
  updatedAt: number,
  overrides: Partial<GatewaySessionRow> = {},
) {
  const actor = { type: "human" as const, ...owner };
  return {
    key,
    kind: "direct",
    displayName: key,
    updatedAt,
    createdActor: actor,
    owner: { actor },
    ...overrides,
  } satisfies GatewaySessionRow;
}

function props(overrides: Partial<Parameters<typeof renderSessionActivityView>[0]> = {}) {
  return {
    context: {
      basePath: "",
      navigate: vi.fn(),
      gateway: { snapshot: { hello: null } },
      agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
      agentSelection: { state: { selectedId: "main" } },
      sessions: { state: { result: { sessions: [] } } },
    } as unknown as ApplicationContext,
    filters: { personId: null, query: "", time: "7d" as const },
    presenceViewers: [] as PresenceViewer[],
    retainedIdentity: null,
    rows: [] as GatewaySessionRow[],
    expandedAutomationDays: new Set<string>(),
    onAutomationDayToggle: vi.fn(),
    onFiltersChange: vi.fn(),
    ...overrides,
  };
}

describe("session activity people filter", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("separates raw fallback identities and maps presence dots by exact viewer id", () => {
    const now = Date.now();
    const container = document.createElement("div");
    document.body.append(container);

    render(
      renderSessionActivityView(
        props({
          rows: [
            row("Online session", { id: "online", label: "Online person" }, now),
            row("Offline session", { id: "offline", label: "Offline person" }, now - 1_000),
            row("Unknown session", { id: "147591189530201337" }, now - 2_000),
            row("Explicit label session", { id: "explicit-id", label: "explicit-id" }, now - 3_000),
          ],
          presenceViewers: [
            {
              id: "online",
              name: "Online person",
              watchedSessions: [],
              entries: [{ instanceId: "online-device", user: { id: "online" }, ts: now }],
            },
          ],
        }),
      ),
      container,
    );

    expect(
      container.querySelector('[data-activity-person="online"] .activity-feed__presence-dot'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-activity-person="offline"] .activity-feed__presence-dot'),
    ).toBeNull();
    expect(
      container.querySelector('[data-activity-person="offline"] .activity-feed__last-active'),
    ).not.toBeNull();
    const unresolved = container.querySelector("[data-activity-unresolved]");
    expect(unresolved?.textContent).toContain("14759118…");
    expect(unresolved?.textContent).not.toContain("147591189530201337");
    expect(unresolved?.querySelector('[data-activity-person="explicit-id"]')).toBeNull();
  });

  it("selecting Everyone clears the person while preserving the other filters", () => {
    const onFiltersChange = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderSessionActivityView(
        props({
          filters: { personId: "online", query: "release", time: "30d" },
          retainedIdentity: { id: "online", name: "Online person", watchedSessions: [] },
          rows: [row("Release session", { id: "online", label: "Online person" }, Date.now())],
          onFiltersChange,
        }),
      ),
      container,
    );

    container.querySelector<HTMLButtonElement>('[data-activity-person=""]')?.click();

    expect(onFiltersChange).toHaveBeenCalledWith({
      personId: null,
      query: "release",
      time: "30d",
    });
  });
});

describe("session activity automation grouping", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("collapses two automation sessions, keeps one inline, and bypasses grouping for filters", () => {
    const current = new Date();
    const now = new Date(
      current.getFullYear(),
      current.getMonth(),
      current.getDate(),
      12,
    ).getTime();
    const owner = { id: "owner", label: "Owner" };
    const regular = row("Regular session", owner, now);
    const automationOne = row("Automation one", owner, now - 1_000, { hasAutomation: true });
    const automationTwo = row("Automation two", owner, now - 2_000, { hasAutomation: true });
    const onAutomationDayToggle = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);

    render(
      renderSessionActivityView(
        props({ rows: [regular, automationOne, automationTwo], onAutomationDayToggle }),
      ),
      container,
    );

    const group = container.querySelector<HTMLButtonElement>("[data-activity-automation-group]");
    expect(group?.textContent).toContain("2 automation sessions");
    expect(group?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll("[data-activity-session]")).toHaveLength(1);
    const dayKey = group?.dataset.activityAutomationGroup;
    expect(dayKey).toBeTruthy();
    group?.click();
    expect(onAutomationDayToggle).toHaveBeenCalledWith(dayKey);

    render(
      renderSessionActivityView(
        props({
          rows: [regular, automationOne, automationTwo],
          expandedAutomationDays: new Set([dayKey!]),
        }),
      ),
      container,
    );
    expect(container.querySelectorAll("[data-activity-session]")).toHaveLength(3);

    render(renderSessionActivityView(props({ rows: [regular, automationOne] })), container);
    expect(container.querySelector("[data-activity-automation-group]")).toBeNull();
    expect(container.querySelectorAll("[data-activity-session]")).toHaveLength(2);

    for (const filteredProps of [
      { filters: { personId: null, query: "Automation", time: "7d" as const } },
      {
        filters: { personId: "owner", query: "", time: "7d" as const },
        retainedIdentity: { id: "owner", name: "Owner", watchedSessions: [] },
      },
    ]) {
      render(
        renderSessionActivityView(
          props({ rows: [automationOne, automationTwo], ...filteredProps }),
        ),
        container,
      );
      expect(container.querySelector("[data-activity-automation-group]")).toBeNull();
      expect(container.querySelectorAll("[data-activity-session]")).toHaveLength(2);
    }
  });
});

describe("session activity live status", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("uses the recorded active run and observer digest for the row status", () => {
    const now = Date.now();
    const owner = { id: "owner", label: "Owner" };
    const observerDigest = {
      headline: "  Waiting on a fake approval  ",
      health: "waiting-on-user" as const,
      revision: 1,
      runId: "fake-run",
      updatedAt: now,
    };
    const container = document.createElement("div");
    document.body.append(container);

    render(
      renderSessionActivityView(
        props({
          rows: [
            row("Active session", owner, now, { hasActiveRun: true, observerDigest }),
            row("Inactive session", owner, now - 1_000, {
              observerDigest,
              status: "running",
            }),
          ],
        }),
      ),
      container,
    );

    const active = container.querySelector('[data-activity-session="Active session"]');
    const inactive = container.querySelector('[data-activity-session="Inactive session"]');
    expect(active?.querySelector(".activity-feed__run-dot")).not.toBeNull();
    expect(active?.querySelector(".activity-feed__session-headline")?.textContent?.trim()).toBe(
      "Waiting on a fake approval",
    );
    expect(
      active?.querySelector(".activity-feed__session-headline")?.getAttribute("data-health"),
    ).toBe("waiting-on-user");
    expect(active?.textContent).toContain("Owner");
    expect(inactive?.querySelector(".activity-feed__run-dot")).toBeNull();
    expect(inactive?.querySelector(".activity-feed__session-headline")).toBeNull();
  });
});
