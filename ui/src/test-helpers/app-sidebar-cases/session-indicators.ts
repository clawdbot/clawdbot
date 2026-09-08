import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../lib/session-pull-requests.ts";
import { reconcileSessionChanged } from "../../lib/sessions/reconcile.ts";
import { createGatewayHarness, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";

function expectEmptyLead(row: Element | null) {
  const lead = row?.querySelector(".sidebar-session-indicator");
  expect(lead).not.toBeNull();
  expect(lead?.childElementCount).toBe(0);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AppSidebar session indicators", () => {
  it("removes a session stripe when a changed event clears its color", async () => {
    const key = "agent:main:color";
    const sessions = createSessionsHarness("main", [key]);
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    const row = () => sidebar.querySelector<HTMLElement>(`[data-session-key="${key}"]`);
    expect(row()?.classList.contains("sidebar-recent-session--colored")).toBe(false);
    sessions.publish({
      result: reconcileSessionChanged(sessions.sessions.state.result, {
        sessionKey: key,
        color: "purple",
      }).result,
    });
    await sidebar.updateComplete;
    expect(row()?.classList.contains("sidebar-recent-session--colored")).toBe(true);
    expect(row()?.style.getPropertyValue("--session-color")).toBe("var(--session-color-purple)");
    sessions.publish({
      result: reconcileSessionChanged(sessions.sessions.state.result, {
        sessionKey: key,
        color: null,
      }).result,
    });
    await sidebar.updateComplete;
    expect(row()?.classList.contains("sidebar-recent-session--colored")).toBe(false);
    expect(row()?.style.getPropertyValue("--session-color")).toBe("");
  });

  it("renders named glyphs as strokes and keeps emoji as text", async () => {
    const glyphKey = "agent:main:glyph";
    const emojiKey = "agent:main:emoji";
    const sessions = createSessionsHarness("main", [glyphKey, emojiKey]);
    const result = sessions.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const glyph = result.sessions.find((row) => row.key === glyphKey);
    const emoji = result.sessions.find((row) => row.key === emojiKey);
    if (!glyph || !emoji) {
      throw new Error("expected icon sessions");
    }
    glyph.icon = "braces";
    emoji.icon = "🦞";

    const { sidebar } = await mountSidebar(
      createGatewayHarness({} as GatewayBrowserClient).gateway,
      sessions.sessions,
    );
    const glyphRow = sidebar.querySelector(`[data-session-key="${glyphKey}"]`);
    const emojiRow = sidebar.querySelector(`[data-session-key="${emojiKey}"]`);

    expect(glyphRow?.querySelector(".session-glyph__icon svg")).not.toBeNull();
    expect(glyphRow?.querySelector(".session-glyph__emoji")).toBeNull();
    expect(emojiRow?.querySelector(".session-glyph__emoji")?.textContent).toBe("🦞");
    expect(emojiRow?.querySelector(".session-glyph__icon")).toBeNull();
  });

  it("prioritizes session icons, then channel avatars, then owner chips", async () => {
    const iconKey = "agent:main:icon-wins";
    const avatarKey = "agent:main:channel-avatar";
    const ownerKey = "agent:main:owner-fallback";
    const sessions = createSessionsHarness("main", [iconKey, avatarKey, ownerKey]);
    const result = sessions.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    for (const row of result.sessions) {
      row.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
      row.owner = { actor: row.createdActor };
      if (row.key !== ownerKey) {
        row.channelAvatarUrl = `/__openclaw__/channel-avatar/${encodeURIComponent(row.key)}`;
      }
    }
    const iconRow = result.sessions.find((row) => row.key === iconKey);
    if (!iconRow) {
      throw new Error("expected icon row");
    }
    iconRow.icon = "🦞";
    result.owners = [
      { type: "human", id: "profile-ada", label: "Ada" },
      { type: "human", id: "profile-bob", label: "Bob" },
    ];

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(["avatar"], { type: "image/png" }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = vi.fn(() => "blob:channel-avatar");
        static override revokeObjectURL = vi.fn();
      },
    );
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    gatewayHarness.gateway.connection.token = "avatar-token";
    const { sidebar } = await mountSidebar(gatewayHarness.gateway, sessions.sessions);

    await waitForFast(() => {
      expect(
        sidebar.querySelector(`[data-session-key="${avatarKey}"] .channel-avatar`),
      ).not.toBeNull();
    });

    const icon = sidebar.querySelector(`[data-session-key="${iconKey}"]`);
    expect(icon?.querySelector(".session-glyph__emoji")?.textContent).toBe("🦞");
    expect(icon?.querySelector("openclaw-channel-avatar")).toBeNull();
    expect(icon?.querySelector(".session-owner-chip")).toBeNull();

    const avatar = sidebar.querySelector(`[data-session-key="${avatarKey}"]`);
    expect(avatar?.querySelector(".session-glyph--circular")).not.toBeNull();
    expect(avatar?.querySelector(".channel-avatar")?.getAttribute("src")).toBe(
      "blob:channel-avatar",
    );
    expect(avatar?.querySelector(".session-owner-chip")).toBeNull();

    const owner = sidebar.querySelector(`[data-session-key="${ownerKey}"]`);
    expect(owner?.querySelector("openclaw-channel-avatar")).toBeNull();
    expect(owner?.querySelector(".session-owner-chip")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      `/__openclaw__/channel-avatar/${encodeURIComponent(avatarKey)}`,
      {
        headers: { Authorization: "Bearer avatar-token" },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("refetches a mounted channel avatar when its route revision changes", async () => {
    const avatarKey = "agent:main:avatar-revision";
    const missingUrl = `/__openclaw__/channel-avatar/${encodeURIComponent(avatarKey)}?v=old`;
    const restoredUrl = `/__openclaw__/channel-avatar/${encodeURIComponent(avatarKey)}?v=new`;
    const sessions = createSessionsHarness("main", [avatarKey]);
    const result = sessions.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const row = result.sessions.find((sessionRow) => sessionRow.key === avatarKey);
    if (!row) {
      throw new Error("expected avatar row");
    }
    row.channelAvatarUrl = missingUrl;
    row.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
    row.owner = { actor: row.createdActor };
    result.owners = [
      { type: "human", id: "profile-ada", label: "Ada" },
      { type: "human", id: "profile-bob", label: "Bob" },
    ];

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("?v=old")) {
        return { ok: false, status: 404, blob: async () => new Blob([]) };
      }
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(["avatar"], { type: "image/png" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = vi.fn(() => "blob:channel-avatar-restored");
        static override revokeObjectURL = vi.fn();
      },
    );
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    gatewayHarness.gateway.connection.token = "avatar-token";
    const { sidebar } = await mountSidebar(gatewayHarness.gateway, sessions.sessions);

    // The pruned avatar 404s and its absence is cached under the old URL; the
    // owner chip must keep the lead slot occupied instead of an empty circle.
    await waitForFast(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const missingRow = sidebar.querySelector(`[data-session-key="${avatarKey}"]`);
    expect(missingRow?.querySelector(".channel-avatar")).toBeNull();
    await waitForFast(() => {
      expect(missingRow?.querySelector(".session-owner-chip")).not.toBeNull();
    });

    // A restored/replaced backing image arrives as a new route revision; the
    // mounted row must fetch the new URL instead of reusing the sticky 404.
    row.channelAvatarUrl = restoredUrl;
    sidebar.requestUpdate();
    await sidebar.updateComplete;

    await waitForFast(() => {
      expect(
        sidebar
          .querySelector(`[data-session-key="${avatarKey}"] .channel-avatar`)
          ?.getAttribute("src"),
      ).toBe("blob:channel-avatar-restored");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      restoredUrl,
      expect.objectContaining({ headers: { Authorization: "Bearer avatar-token" } }),
    );
    // Once the avatar renders, the chip fallback yields to the real image.
    expect(
      sidebar.querySelector(`[data-session-key="${avatarKey}"] .session-owner-chip`),
    ).toBeNull();
  });

  it("keeps the owner chip when avatar auth is not ready", async () => {
    const avatarKey = "agent:main:avatar-auth-pending";
    const sessions = createSessionsHarness("main", [avatarKey]);
    const result = sessions.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const row = result.sessions.find((sessionRow) => sessionRow.key === avatarKey);
    if (!row) {
      throw new Error("expected avatar row");
    }
    row.channelAvatarUrl = `/__openclaw__/channel-avatar/${encodeURIComponent(avatarKey)}`;
    row.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
    row.owner = { actor: row.createdActor };
    result.owners = [
      { type: "human", id: "profile-ada", label: "Ada" },
      { type: "human", id: "profile-bob", label: "Bob" },
    ];

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    // No handshake and no token/password: the loader must not fetch, and the
    // row must show the owner chip rather than an empty circle.
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const pendingSnapshot = gatewayHarness.gateway.snapshot as { hello: unknown };
    pendingSnapshot.hello = null;
    const { sidebar } = await mountSidebar(gatewayHarness.gateway, sessions.sessions);

    const pendingRow = sidebar.querySelector(`[data-session-key="${avatarKey}"]`);
    expect(pendingRow?.querySelector("openclaw-channel-avatar")).not.toBeNull();
    expect(pendingRow?.querySelector(".channel-avatar")).toBeNull();
    await waitForFast(() => {
      expect(pendingRow?.querySelector(".session-owner-chip")).not.toBeNull();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["running", "queued"] as const)(
    "rings Home for %s activity while keeping its draft and outbox badges trailing",
    async (status) => {
      const mainKey = "agent:main:main";
      const workingKey = "agent:main:working";
      const sessions = createSessionsHarness("main", [mainKey, workingKey]);
      const result = sessions.sessions.state.result;
      if (!result) {
        throw new Error("expected session list");
      }
      for (const row of result.sessions) {
        row.hasActiveRun = true;
        row.status = status;
        if (row.key === mainKey) {
          row.unread = true;
        }
      }
      const { sidebar } = await mountSidebar(
        createGatewayHarness({} as GatewayBrowserClient).gateway,
        sessions.sessions,
      );
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = workingKey;
      sidebar.outboxAttentionCountForSession = (sessionKey) => (sessionKey === mainKey ? 2 : 0);
      sidebar.hasSessionDraft = (sessionKey) => sessionKey === mainKey;
      sidebar.requestUpdate();
      await sidebar.updateComplete;

      const home = sidebar.querySelector(".nav-item--home");
      const homeRing = home?.querySelector(".session-glyph--running .session-glyph__ring");
      expect(home?.querySelector(".session-glyph__content .nav-item__icon")).not.toBeNull();
      expect(homeRing).not.toBeNull();
      expect(home?.querySelector(".nav-item__state .session-run-spinner")).toBeNull();
      expect(home?.querySelector(".session-unread-dot")).toBeNull();
      const activityLabel = status === "queued" ? "Queued" : "Active run";
      expect(homeRing?.getAttribute("aria-label")).toBe(activityLabel);
      expect(homeRing?.classList.contains("session-glyph__ring--queued")).toBe(status === "queued");
      expect(home?.getAttribute("aria-label")).toBe(`Home · ${activityLabel} · Unread`);
      expect(
        home?.querySelector(".nav-item__state .session-row-badge--attention")?.textContent,
      ).toContain("2");
      expect(home?.querySelector(".nav-item__state .session-row-badge--draft")).not.toBeNull();
    },
  );

  it.each(["running", "queued"] as const)(
    "announces %s and unread once with an owner chip or an empty leading slot",
    async (status) => {
      const keys = ["agent:main:owned-running", "agent:main:plain-running"];
      const sessions = createSessionsHarness("main", keys);
      const result = sessions.sessions.state.result!;
      for (const row of result.sessions) {
        row.hasActiveRun = true;
        row.status = status;
        row.unread = true;
        if (row.key === keys[0]) {
          row.owner = { actor: { type: "human", id: "ada", label: "Ada" } };
        }
      }
      result.owners = [
        { type: "human", id: "ada", label: "Ada" },
        { type: "human", id: "bob", label: "Bob" },
      ];
      const { sidebar } = await mountSidebar(
        createGatewayHarness({} as GatewayBrowserClient).gateway,
        sessions.sessions,
      );
      for (const key of keys) {
        const row = sidebar.querySelector(`[data-session-key="${key}"]`)!;
        const ring = row.querySelector(
          ".sidebar-session-indicator .session-glyph--running .session-glyph__ring",
        );
        expect.soft(ring).not.toBeNull();
        expect.soft(row.querySelector(".session-row-state")).toBeNull();
        expect(row.querySelector(".session-unread-dot")).toBeNull();
        expect(row.querySelector(".session-glyph__badge--unread")).toBeNull();
        expect(row.querySelector(".session-owner-chip") !== null).toBe(key === keys[0]);
        const link = row.querySelector("a")!;
        const description = sidebar.querySelector(
          `[id="${link.getAttribute("aria-describedby")}"]`,
        )!;
        expect.soft(description.textContent).toBe("Unread");
        expect.soft(description.getAttribute("aria-hidden")).toBe("true");
        expect
          .soft(ring?.getAttribute("aria-label"))
          .toBe(status === "queued" ? "Queued" : "Active run");
        expect.soft(row.querySelectorAll('[aria-label="Unread"]')).toHaveLength(0);
      }
    },
  );

  it("preserves child PR indicators and leads a pinned child like any other", async () => {
    const parentKey = "agent:main:parent";
    const pinnedKey = "agent:main:pinned-child";
    const runningKey = "agent:main:running-child";
    const queuedKey = "agent:main:queued-child";
    const openPullRequestKey = "agent:main:open-pr-child";
    const mergedPullRequestKey = "agent:main:merged-pr-child";
    const sessions = createSessionsHarness("main", [parentKey]);
    sessions.list.mockResolvedValue({
      ts: 2,
      path: "",
      count: 5,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: pinnedKey,
          spawnedBy: parentKey,
          kind: "direct",
          label: "Pinned child",
          updatedAt: 2,
          pinned: true,
          hasActiveRun: true,
          status: "running",
          unread: true,
          worktree: { id: "wt-pinned", branch: "feature/pinned", repoRoot: "/repo" },
        },
        {
          key: runningKey,
          spawnedBy: parentKey,
          kind: "direct",
          label: "Running child",
          updatedAt: 2,
          hasActiveRun: true,
          status: "running",
          unread: true,
          worktree: { id: "wt-running", branch: "feature/running", repoRoot: "/repo" },
        },
        {
          key: queuedKey,
          spawnedBy: parentKey,
          kind: "direct",
          label: "Queued child",
          updatedAt: 2,
          hasActiveRun: true,
          status: "queued",
        },
        {
          key: openPullRequestKey,
          spawnedBy: parentKey,
          kind: "direct",
          label: "Open PR child",
          updatedAt: 2,
          hasActiveRun: true,
          status: "queued",
          unread: true,
          agentStatus: {
            note: "Waiting for input",
            attention: "key",
            expiresAt: Date.now() + 60_000,
          },
          worktree: { id: "wt-open", branch: "feature/open", repoRoot: "/repo" },
        },
        {
          key: mergedPullRequestKey,
          spawnedBy: parentKey,
          kind: "direct",
          label: "Merged PR child",
          updatedAt: 2,
          worktree: { id: "wt-merged", branch: "feature/merged", repoRoot: "/repo" },
        },
      ],
    });
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gatewayHarness.gateway, sessions.sessions);
    sessions.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: parentKey,
            kind: "direct",
            label: "Parent",
            updatedAt: 1,
            childSessions: [
              pinnedKey,
              runningKey,
              queuedKey,
              openPullRequestKey,
              mergedPullRequestKey,
            ],
          },
        ],
      },
    });
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();
    await waitForFast(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(4),
    );
    sidebar.querySelector<HTMLButtonElement>("[data-show-more-children]")?.click();
    await waitForFast(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(5),
    );
    sessions.sessions.setPullRequestSummary(openPullRequestKey, { numbers: [1], state: "open" });
    sessions.sessions.setPullRequestSummary(mergedPullRequestKey, {
      numbers: [2],
      state: "merged",
    });
    sidebar.requestUpdate();
    await sidebar.updateComplete;

    await waitForFast(() => {
      expect(
        sidebar.querySelector(
          `[data-session-key="${openPullRequestKey}"] [data-pull-request-state="open"]`,
        ),
      ).not.toBeNull();
      expect(
        sidebar.querySelector(
          `[data-session-key="${mergedPullRequestKey}"] [data-pull-request-state="merged"]`,
        ),
      ).not.toBeNull();
    });
    // Pinning is not a status: a pinned child must lead exactly like an
    // unpinned child in the same run/unread state.
    const pinnedRow = sidebar.querySelector(`[data-session-key="${pinnedKey}"]`);
    const runningRow = sidebar.querySelector(`[data-session-key="${runningKey}"]`);
    const pinnedLead = pinnedRow?.querySelector(".sidebar-session-indicator");
    const runningLead = runningRow?.querySelector(".sidebar-session-indicator");
    expect(pinnedLead).not.toBeNull();
    expect(pinnedLead?.innerHTML).toBe(runningLead?.innerHTML);
    expect(pinnedLead?.querySelector("[data-pull-request-state]")).toBeNull();
    expect(pinnedRow?.querySelector(".session-row-state")).toBeNull();

    for (const [key, label] of [
      [pinnedKey, "Active run"],
      [runningKey, "Active run"],
      [queuedKey, "Queued"],
    ] as const) {
      const ring = sidebar.querySelector(
        `[data-session-key="${key}"] .sidebar-session-indicator .session-glyph--running .session-glyph__ring`,
      );
      expect.soft(ring).not.toBeNull();
      expect.soft(ring?.getAttribute("aria-label")).toBe(label);
      expect.soft(ring?.classList.contains("session-glyph__ring--queued")).toBe(label === "Queued");
    }
    expect(
      sidebar.querySelectorAll(
        ".sidebar-recent-session .sidebar-session-indicator .session-run-spinner",
      ),
    ).toHaveLength(0);

    const attentionLead = sidebar.querySelector(
      `[data-session-key="${openPullRequestKey}"] .sidebar-session-indicator`,
    );
    expect(attentionLead?.querySelector('[data-session-attention="agent"]')).not.toBeNull();
    expect(attentionLead?.querySelector(".session-glyph__ring")).not.toBeNull();
    expect(
      attentionLead?.querySelector(".session-glyph__ring--queued")?.getAttribute("aria-label"),
    ).toBe("Queued");
    expect(attentionLead?.querySelector(".session-glyph__badge--unread")).toBeNull();
    expect(attentionLead?.querySelector("[data-pull-request-state]")).toBeNull();
    const attentionLink = sidebar.querySelector(
      `[data-session-key="${openPullRequestKey}"] .sidebar-recent-session__link`,
    );
    const attentionDescriptionId = attentionLink?.getAttribute("aria-describedby");
    expect(attentionDescriptionId).toBe(
      `sidebar-session-state-${encodeURIComponent(openPullRequestKey)}`,
    );
    expect(sidebar.querySelector(`[id="${attentionDescriptionId}"]`)?.textContent).toBe("Unread");
  });

  it("prioritizes an active run over unread activity", async () => {
    const keys = {
      plain: "agent:main:plain",
      forked: "agent:main:forked",
      unread: "agent:main:unread",
      runningUnread: "agent:main:status-running-unread",
      openPullRequest: "agent:main:open-pr",
      mergedPullRequest: "agent:main:merged-pr",
    };
    const sessions = createSessionsHarness("main", Object.values(keys));
    const result = sessions.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    for (const row of result.sessions) {
      if (row.key === keys.forked) {
        row.forkSource = { sessionKey: "agent:main:main", sessionId: "source-session" };
      } else if (row.key === keys.unread) {
        row.unread = true;
      } else if (row.key === keys.runningUnread) {
        row.status = "running";
        row.unread = true;
      } else if (row.key === keys.openPullRequest || row.key === keys.mergedPullRequest) {
        row.worktree = {
          id: `wt-${row.key}`,
          branch: row.key.endsWith("open-pr") ? "feature/open" : "feature/merged",
          repoRoot: "/repo",
        };
      }
    }
    const request = vi.fn(() => Promise.resolve({ subscribed: true }));
    const gatewayHarness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    gatewayHarness.publish({
      hello: {
        features: { methods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const { sidebar } = await mountSidebar(gatewayHarness.gateway, sessions.sessions);
    sidebar.connected = true;
    await sidebar.updateComplete;
    await waitForFast(() => {
      expect(request).toHaveBeenCalledWith(
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        expect.objectContaining({
          sessionKeys: expect.arrayContaining([keys.openPullRequest, keys.mergedPullRequest]),
        }),
      );
    });
    gatewayHarness.publishEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
      sessions: Object.fromEntries(
        [keys.openPullRequest, keys.mergedPullRequest].map((key) => [
          key,
          {
            pullRequests: [
              {
                number: 1,
                owner: "openclaw",
                repo: "openclaw",
                branch: "feature/test",
                title: "Test",
                url: "https://example.test/pr/1",
                state: key.endsWith("open-pr") ? "open" : "merged",
              },
            ],
            rateLimited: false,
            status: "ready",
          },
        ]),
      ),
    });

    await waitForFast(() => {
      expect(sidebar.querySelector('[data-pull-request-state="open"]')).not.toBeNull();
      expect(sidebar.querySelector('[data-pull-request-state="merged"]')).not.toBeNull();
    });
    // Opening chat hydrates its detailed summary from the same pushed snapshot.
    // It must not add a second PR icon beside the sidebar's existing indicator.
    sessions.sessions.setPullRequestSummary(keys.openPullRequest, { numbers: [1], state: "open" });
    await sidebar.updateComplete;
    expect(
      sidebar.querySelectorAll(
        `[data-session-key="${keys.openPullRequest}"] :is([data-session-pr-state], [data-pull-request-state])`,
      ),
    ).toHaveLength(1);
    const plain = sidebar.querySelector(`[data-session-key="${keys.plain}"]`);
    expectEmptyLead(plain);
    expect(plain?.querySelector(".session-row-state")).toBeNull();

    const forked = sidebar.querySelector(`[data-session-key="${keys.forked}"]`);
    expectEmptyLead(forked);
    const forkIndicator = forked?.querySelector(
      ".sidebar-recent-session__name .sidebar-session-fork-indicator",
    );
    expect(forkIndicator).not.toBeNull();
    expect(forkIndicator?.getAttribute("aria-label")).toBe("Forked session");
    expect(forkIndicator?.hasAttribute("title")).toBe(false);
    expect(forked?.querySelector(".session-row-state")).toBeNull();

    const unread = sidebar.querySelector(`[data-session-key="${keys.unread}"]`);
    expect(unread?.querySelector(".sidebar-session-indicator .session-unread-dot")).not.toBeNull();
    expect(unread?.querySelector(".session-row-state")).toBeNull();
    expect(unread?.querySelector("a")?.hasAttribute("aria-describedby")).toBe(false);

    const runningUnread = sidebar.querySelector(`[data-session-key="${keys.runningUnread}"]`);
    expect(runningUnread?.classList.contains("session-row-host--running")).toBe(true);
    expect(
      runningUnread?.querySelector(".sidebar-session-indicator .session-glyph__ring"),
    ).not.toBeNull();
    expect(runningUnread?.querySelector(".session-row-state")).toBeNull();
    expect(runningUnread?.querySelector(".session-unread-dot")).toBeNull();
    expect(runningUnread?.querySelector(".session-glyph__badge--unread")).toBeNull();

    for (const key of [keys.forked, keys.runningUnread]) {
      const link = sidebar.querySelector(`[data-session-key="${key}"] a`);
      const descriptionId = link?.getAttribute("aria-describedby");
      expect(descriptionId).toBe(`sidebar-session-state-${encodeURIComponent(key)}`);
      expect(sidebar.querySelector(`[id="${descriptionId}"]`)).not.toBeNull();
    }
    for (const row of [forked, unread, runningUnread]) {
      expect(row?.querySelector("a")?.hasAttribute("title")).toBe(false);
    }
    expect(runningUnread?.querySelector(".sr-only")?.textContent).toBe("Unread");

    const openPullRequestIcon = sidebar.querySelector(
      `[data-session-key="${keys.openPullRequest}"] [data-pull-request-state="open"] svg`,
    );
    const mergedPullRequestIcon = sidebar.querySelector(
      `[data-session-key="${keys.mergedPullRequest}"] [data-pull-request-state="merged"] svg`,
    );
    expect(openPullRequestIcon).not.toBeNull();
    expect(mergedPullRequestIcon).not.toBeNull();
    expect(openPullRequestIcon?.isEqualNode(mergedPullRequestIcon ?? null)).toBe(false);

    for (const key of [keys.openPullRequest, keys.mergedPullRequest]) {
      const row = sidebar.querySelector(`[data-session-key="${key}"]`);
      expectEmptyLead(row);
      expect(row?.querySelector(".session-row-badges [data-pull-request-state]")).not.toBeNull();
      expect(row?.querySelector("a")?.hasAttribute("title")).toBe(false);
      expect(row?.querySelector("[data-pull-request-state]")?.hasAttribute("title")).toBe(false);
    }

    const openPullRequestRow = result.sessions.find((row) => row.key === keys.openPullRequest);
    if (!openPullRequestRow) {
      throw new Error("expected open PR session");
    }
    sessions.sessions.setPullRequestSummary(keys.openPullRequest, undefined);
    openPullRequestRow.worktree = undefined;
    sessions.publishList({ result });
    await waitForFast(() => {
      expect(sidebar.querySelector('[data-pull-request-state="open"]')).toBeNull();
      expectEmptyLead(sidebar.querySelector(`[data-session-key="${keys.openPullRequest}"]`));
    });
  });

  it("keeps an idle parent's glyph unringed while a hidden child runs", async () => {
    const parentKey = "agent:main:idle-parent";
    const sessions = createSessionsHarness("main", [parentKey]);
    const row = sessions.sessions.state.result!.sessions[0]!;
    row.hasActiveRun = false;
    row.hasActiveSubagentRun = true;
    row.childSessions = ["agent:main:idle-parent-child"];
    const { sidebar } = await mountSidebar(
      createGatewayHarness({} as GatewayBrowserClient).gateway,
      sessions.sessions,
    );
    const parent = sidebar.querySelector(`[data-session-key="${parentKey}"]`)!;
    // Descendant activity is a right-side summary on the collapsed toggle; only
    // the row's own run may ring its glyph.
    expectEmptyLead(parent);
    expect(parent.querySelector(".sidebar-child-session-toggle--running")).not.toBeNull();
    expect(parent.querySelector(".session-row-state .session-run-spinner")).toBeNull();
  });
});
