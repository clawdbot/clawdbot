/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { PresenceViewer } from "../../lib/presence-users.ts";
import { renderSessionActivityView } from "./session-activity-view.ts";

function row(key: string, owner: { id: string; label?: string }, updatedAt: number) {
  const actor = { type: "human" as const, ...owner };
  return {
    key,
    kind: "direct",
    displayName: key,
    updatedAt,
    createdActor: actor,
    owner: { actor },
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
