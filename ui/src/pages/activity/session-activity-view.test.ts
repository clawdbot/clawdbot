/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import type { PresenceViewer } from "../../lib/presence-users.ts";
import { SESSION_NAVIGATION_KEY_PARAM } from "../../lib/sessions/route-navigation.ts";
import { renderSessionActivityView } from "./session-activity-view.ts";

function row(
  key: string,
  owner: { id: string; label?: string },
  updatedAt: number,
  overrides: Partial<GatewaySessionRow> = {},
) {
  const actor = {
    type: "human" as const,
    ...owner,
    identity: { type: "profile" as const, id: owner.id },
  };
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

function props({
  rows = [],
  ...overrides
}: Partial<Parameters<typeof renderSessionActivityView>[0]> & {
  rows?: GatewaySessionRow[];
} = {}): Parameters<typeof renderSessionActivityView>[0] {
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
    result: {
      ts: 1,
      path: "",
      count: rows.length,
      sessions: rows,
      defaults: { model: null, modelProvider: null, contextTokens: null },
      people: [
        {
          identity: { type: "profile" as const, id: "online" },
          label: "Online person",
          sessionCount: 1,
        },
        {
          identity: { type: "profile" as const, id: "offline" },
          label: "Offline person",
          sessionCount: 1,
        },
      ],
    },
    loading: false,
    retrying: false,
    onRetry: vi.fn(),
    expandedAutomationDays: new Set<string>(),
    onAutomationDayToggle: vi.fn(),
    onFiltersChange: vi.fn(),
    ...overrides,
  };
}

describe("session activity semantics", () => {
  afterEach(() => {
    setAvatarGatewayOrigin(null);
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("leaves the page main landmark to the app shell", () => {
    const container = document.createElement("div");
    document.body.append(container);

    render(renderSessionActivityView(props()), container);

    expect(container.querySelectorAll("main")).toHaveLength(0);
  });

  it.each(["missing", "stale"])(
    "opens the displayed Activity rows when the sidebar is %s",
    (sidebar) => {
      const rows = (["chat", "dashboard"] as const).map((face, index) =>
        row(
          `agent:research:${face}:12345678-90ab-cdef-1234-567890abcde${index}`,
          { id: "owner" },
          Date.now(),
          { boardFace: face, displayName: `Research ${face}` },
        ),
      );
      const input = props({ rows });
      input.context = {
        ...input.context,
        basePath: "/control",
        agentSelection: { state: { selectedId: "other" } },
        sessions: {
          state: {
            agentId: "other",
            result: {
              sessions:
                sidebar === "missing"
                  ? []
                  : rows.map((session) => ({ ...session, displayName: "Old title" })),
            },
          },
        },
      } as unknown as ApplicationContext;
      const container = document.createElement("div");
      document.body.append(container);

      render(renderSessionActivityView(input), container);

      const links = container.querySelectorAll<HTMLAnchorElement>("[data-activity-session]");
      expect(links).toHaveLength(rows.length);
      for (const [index, session] of rows.entries()) {
        const link = links[index]!;
        const pathname = `/control/${session.boardFace}/research/research-${session.boardFace}-12345678`;
        expect(link.getAttribute("href")).toBe(pathname);
        link.click();
        expect(input.context.navigate).toHaveBeenLastCalledWith(session.boardFace, {
          pathname,
          search: `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(session.key)}`,
        });
      }
    },
  );

  it.each([
    ["workspace", "/control/chat/research", undefined],
    ["global", "/control/chat/research", undefined],
    [
      "catalog:native:gateway%3Alocal:Thread-1",
      "/control/chat/research",
      "?catalog=native&host=gateway%3Alocal&thread=Thread-1",
    ],
  ] as const)(
    "preserves configured main and selected-agent routing for %s",
    (key, pathname, search) => {
      const input = props({ rows: [row(key, { id: "owner" }, Date.now())] });
      input.context = {
        ...input.context,
        basePath: "/control",
        agents: { state: { agentsList: { defaultId: "main", mainKey: "workspace" } } },
        agentSelection: { state: { selectedId: "research" } },
      } as unknown as ApplicationContext;
      const container = document.createElement("div");
      document.body.append(container);

      render(renderSessionActivityView(input), container);

      const link = container.querySelector<HTMLAnchorElement>("[data-activity-session]")!;
      expect(link.getAttribute("href")).toBe(`${pathname}${search ?? ""}`);
      link.click();
      expect(input.context.navigate).toHaveBeenCalledWith(
        "chat",
        search ? { pathname, search } : { pathname },
      );
    },
  );

  it("renders agent-owned sessions and profile pictures without making agents or channels people", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "content-type": url.endsWith("/avatar/research") ? "image/jpeg" : "image/png",
        },
      });
    });
    // Identify each image by its content type, not the order concurrent fetches finish.
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) =>
      "type" in blob && blob.type === "image/png" ? "blob:human" : "blob:agent",
    );
    const agent = {
      type: "agent" as const,
      id: "research",
      identity: { type: "agent" as const, id: "research" },
      label: "Research",
      avatarUrl: "/avatar/research",
    };
    const human = {
      type: "human" as const,
      id: "person",
      identity: { type: "profile" as const, id: "person" },
      label: "Person",
      avatarUrl: "/api/users/person/avatar",
    };
    const container = document.createElement("div");
    document.body.append(container);
    const channel = {
      ...human,
      identity: { type: "legacy" as const, actorType: "human", source: "channel", id: "person" },
    };
    const rows = [
      row("Human session", human, Date.now(), { owner: { actor: human } }),
      row("Agent session", agent, Date.now() - 1, {
        owner: { actor: agent },
        createdActor: agent,
      }),
      row("Unattributed session", agent, Date.now() - 2, {
        owner: undefined,
        createdActor: undefined,
        agentId: "research",
      }),
      row("Channel session", channel, Date.now() - 3, {
        owner: { actor: channel },
        createdActor: channel,
      }),
    ];
    render(
      renderSessionActivityView(
        props({
          rows,
          result: {
            ts: 1,
            path: "",
            count: rows.length,
            sessions: rows,
            defaults: { model: null, modelProvider: null, contextTokens: null },
            people: [
              {
                identity: human.identity,
                label: human.label,
                avatarUrl: human.avatarUrl,
                sessionCount: 1,
              },
            ],
          },
        }),
      ),
      container,
    );
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-activity-session="Human session"] img')?.getAttribute("src"),
      ).toBe("blob:human");
      expect(
        container.querySelector('[data-activity-session="Agent session"] img')?.getAttribute("src"),
      ).toBe("blob:agent");
      expect(
        container.querySelector('[data-activity-person="person"] img')?.getAttribute("src"),
      ).toBe("blob:human");
      expect(container.querySelector('[data-activity-person="research"]')).toBeNull();
      expect(container.querySelector('[data-activity-session="Channel session"] img')).toBeNull();
      expect(
        container
          .querySelector('[data-activity-session="Unattributed session"] img')
          ?.getAttribute("src"),
      ).toBe("blob:agent");
    });
  });
});

describe("session activity people filter", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("uses the server people facet, excludes raw identities, and maps presence by exact profile id", () => {
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
              identity: { type: "profile", id: "online" },
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
    ).toBeNull();
    expect(container.querySelector('[data-activity-person="147591189530201337"]')).toBeNull();
    expect(container.querySelector('[data-activity-person="explicit-id"]')).toBeNull();
    expect(
      container
        .querySelector('[data-activity-person="offline"] .activity-feed__people-count')
        ?.textContent?.trim(),
    ).toBe("1");
  });

  it.each([false, true])(
    "keeps online identity details and only known watched sessions in recency order (facet present: %s)",
    (hasFacet) => {
      const container = document.createElement("div");
      document.body.append(container);
      const input = props({
        filters: { personId: "online", query: "", time: "7d" },
        rows: [
          row("agent:main:first", { id: "online" }, 10),
          row("agent:main:second", { id: "online" }, 20),
          row("agent:main:unwatched", { id: "online" }, 30),
        ],
        presenceViewers: [
          {
            id: "online",
            identity: { type: "profile", id: "online" },
            email: "online@example.test",
            watchedSessions: ["agent:main:first", "agent:main:second", "missing"],
            entries: [
              {
                host: "Alice's Mac",
                platform: "Win32",
                deviceFamily: "Mac16,6",
                ip: "203.0.113.7",
                timeZone: "Europe/Vienna",
                lastInputSeconds: 30,
                ts: 10,
              },
              { host: "Alice's phone", ts: 20 },
            ],
          },
        ],
      });
      if (!hasFacet) {
        input.result!.people = [];
      }
      render(renderSessionActivityView(input), container);
      const identity = container.querySelector('[data-activity-identity="online"]');
      // A sparse online identity wins as a whole, without borrowing the facet's label.
      expect(identity?.querySelector("h2")?.textContent).toBe("online@example.test");
      expect(identity?.textContent).toContain("Online");
      expect(
        [...container.querySelectorAll(".activity-feed__device-name")].map((device) =>
          device.textContent?.trim(),
        ),
      ).toEqual(["Alice's Mac", "Alice's phone"]);
      const device = identity?.querySelector(".activity-feed__device")?.textContent;
      expect(device).toContain("203.0.113.7");
      expect(device).toContain("Europe/Vienna");
      expect(
        [...container.querySelectorAll(".activity-feed__viewing-list [data-activity-session]")].map(
          (session) => session.getAttribute("data-activity-session"),
        ),
      ).toEqual(["agent:main:second", "agent:main:first"]);
    },
  );

  it.each(["offline", "unknown", "Offline"])(
    "resolves the selected %s identity only from an exact server profile facet",
    (personId) => {
      const container = document.createElement("div");
      document.body.append(container);
      const input = props({
        filters: { personId, query: "", time: "7d" },
        rows: [
          row("Visible session", { id: personId, label: "Row actor" }, 10, {
            participants: [{ identity: { type: "profile", id: personId }, label: "Preview actor" }],
          }),
        ],
      });
      render(renderSessionActivityView({ ...input, result: undefined, loading: true }), container);
      expect(container.querySelector(".activity-feed__not-found")).toBeNull();
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading");

      render(renderSessionActivityView(input), container);
      if (personId === "offline") {
        const identity = container.querySelector('[data-activity-identity="offline"]');
        expect(identity?.querySelector("h2")?.textContent).toBe("Offline person");
        expect(identity?.textContent).toContain("Offline");
        expect(identity?.querySelector(".activity-feed__viewing-list")).toBeNull();
      } else {
        expect(container.querySelector(".activity-feed__not-found")).not.toBeNull();
        expect(container.querySelector("[data-activity-identity]")).toBeNull();
        expect(container.querySelector("[data-activity-session]")).toBeNull();
      }
    },
  );

  it.each([true, false])(
    "never joins raw presence into a profile Activity page (profile online: %s)",
    (online) => {
      const container = document.createElement("div");
      document.body.append(container);
      const input = props({
        filters: { personId: "online", query: "", time: "7d" },
        rows: [row("raw-watch", { id: "online" }, 10)],
        presenceViewers: [
          ...(online
            ? [
                {
                  id: "online",
                  identity: { type: "profile" as const, id: "online" },
                  name: "Profile person",
                  watchedSessions: [],
                  entries: [{ host: "Profile device", ts: 1 }],
                },
              ]
            : []),
          {
            id: "online",
            name: "Raw collider",
            watchedSessions: ["raw-watch"],
            entries: [{ host: "Raw device", ts: 1 }],
          },
        ],
      });
      render(renderSessionActivityView(input), container);
      const identity = container.querySelector("[data-activity-identity]")!;
      expect(identity.querySelector("h2")?.textContent).toBe(
        online ? "Profile person" : "Online person",
      );
      expect(identity.textContent).not.toContain("Raw device");
      expect(identity.querySelector(".activity-feed__viewing-list")).toBeNull();
      expect(
        container.querySelectorAll(".activity-feed__people-row .activity-feed__presence-dot"),
      ).toHaveLength(online ? 1 : 0);
    },
  );

  it("selecting Everyone clears the person while preserving the other filters", () => {
    const onFiltersChange = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderSessionActivityView(
        props({
          filters: { personId: "online", query: "release", time: "30d" },
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
        presenceViewers: [
          {
            id: "owner",
            identity: { type: "profile" as const, id: "owner" },
            name: "Owner",
            watchedSessions: [],
          },
        ],
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

  it("labels only cron-origin sessions from their recorded creation provenance", () => {
    const container = document.createElement("div");
    document.body.append(container);

    render(
      renderSessionActivityView(
        props({
          rows: [
            row("Scheduled report", { id: "owner", label: "Owner" }, Date.now(), {
              createdVia: "cron",
            }),
            row("Automation-bound chat", { id: "owner", label: "Owner" }, Date.now() - 1, {
              hasAutomation: true,
            }),
          ],
        }),
      ),
      container,
    );

    expect(
      container
        .querySelector(
          '[data-activity-session="Scheduled report"] [data-activity-created-via="cron"]',
        )
        ?.textContent?.trim(),
    ).toContain("Automation");
    expect(
      container.querySelector(
        '[data-activity-session="Automation-bound chat"] [data-activity-created-via]',
      ),
    ).toBeNull();
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
            row("Active session", owner, now, {
              activeRunIds: ["fake-run"],
              hasActiveRun: true,
              observerDigest,
            }),
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

  it("shows and links only observer digests with exact active-run membership", () => {
    const now = Date.now();
    const owner = { id: "owner", label: "Owner" };
    const base = props();
    const context = { ...base.context, basePath: "/control" } as ApplicationContext;
    const container = document.createElement("div");
    document.body.append(container);

    render(
      renderSessionActivityView(
        props({
          context,
          rows: [
            row("Digest run", owner, now, {
              activeRunIds: ["fallback-run", "digest run:a/b"],
              hasActiveRun: true,
              observerDigest: {
                headline: "Running",
                health: "on-track",
                revision: 1,
                runId: "digest run:a/b",
                updatedAt: now,
              },
            }),
            row("Stale digest", owner, now - 500, {
              activeRunIds: ["current-run"],
              hasActiveRun: true,
              observerDigest: {
                headline: "Running",
                health: "on-track",
                revision: 1,
                runId: "ended-run",
                updatedAt: now,
              },
            }),
            row("Active run fallback", owner, now - 1_000, {
              activeRunIds: ["fallback run:a/b"],
              hasActiveRun: true,
            }),
            row("Inactive run", owner, now - 2_000, {
              activeRunIds: ["inactive-run"],
            }),
          ],
        }),
      ),
      container,
    );

    expect(
      [...container.querySelectorAll<HTMLAnchorElement>(".activity-feed__inspect-run")].map(
        (link) => link.getAttribute("href"),
      ),
    ).toEqual(["/control/activity?view=run&run=digest%20run%3Aa%2Fb"]);
    expect(
      container
        .querySelector('[data-activity-session="Digest run"] .activity-feed__session-headline')
        ?.textContent?.trim(),
    ).toBe("Running");
    expect(
      container.querySelector(
        '[data-activity-session="Stale digest"] .activity-feed__session-headline',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-activity-session="Active run fallback"] .activity-feed__session-headline',
      ),
    ).toBeNull();
  });
});
