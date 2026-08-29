/* @vitest-environment jsdom */

import type { ProgressCard } from "@openclaw/gateway-protocol";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlUiSessionPullRequestSnapshot } from "../../../src/gateway/control-ui-contract.js";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { renderSessionHovercard } from "./session-hovercard.ts";

function row(overrides: Partial<SidebarRecentSession> = {}): SidebarRecentSession {
  return {
    key: "agent:main:work",
    label: "Ship the release",
    createdAt: Date.now() - 2 * 60 * 60_000,
    startedAt: Date.now() - 2 * 60 * 60_000,
    updatedAt: Date.now() - 5 * 60_000,
    createdActor: {
      type: "human",
      id: "alice",
      identity: { type: "profile", id: "alice" },
      label: "Alice Baker",
    },
    subtitle: "openclaw ⎇ feature/session-hovercard",
    workContext: {
      kind: "project",
      name: "openclaw",
      path: "/work/openclaw",
      branch: "feature/session-hovercard",
    },
    children: [],
    ...overrides,
  } as SidebarRecentSession;
}

function snapshot(
  overrides: Partial<ControlUiSessionPullRequestSnapshot> = {},
): ControlUiSessionPullRequestSnapshot {
  return { status: "ready", pullRequests: [], rateLimited: false, ...overrides };
}

function progressCard(): ProgressCard {
  return {
    sessionKey: "agent:main:work",
    revision: 1,
    updatedAt: Date.now(),
    markdown: "**Release** is ready.",
    steps: [{ step: "Verify", status: "in_progress" }],
  };
}

describe("renderSessionHovercard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T12:00:00Z"));
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("renders header and session metadata without inventing optional sections", () => {
    const container = document.createElement("div");
    render(renderSessionHovercard({ row: row() }), container);

    expect(container.querySelector(".session-hovercard__title")?.textContent).toBe(
      "Ship the release",
    );
    expect(container.querySelector(".session-hovercard__created-age")?.textContent).toBe("2 hr");
    expect(container.querySelector(".session-hovercard__meta")?.textContent).toBe("Updated 5m ago");
    expect(container.querySelector(".session-hovercard__identity-row")?.textContent).toContain(
      "Alice Baker",
    );
    expect(
      [...container.querySelectorAll(".session-hovercard__context-text")].map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["openclaw", "feature/session-hovercard"]);
    expect(
      [...container.querySelectorAll(".session-hovercard__section")].map((section) =>
        [...section.classList].find((name) => name.startsWith("session-hovercard__section--")),
      ),
    ).toEqual(["session-hovercard__section--header", "session-hovercard__section--metadata"]);
    expect(container.querySelector(".session-progress-card")).toBeNull();
    expect(container.querySelector(".session-hovercard__excerpt")).toBeNull();
  });

  it.each([
    { name: "dashboard", facts: { boardFace: "dashboard" }, labels: ["Dashboard available"] },
    { name: "automation", facts: { hasAutomation: true }, labels: ["Automation attached"] },
    {
      name: "both",
      facts: { boardFace: "dashboard", hasAutomation: true },
      labels: ["Dashboard available", "Automation attached"],
    },
    { name: "absent", facts: {}, labels: [] },
    { name: "disabled", facts: { boardFace: "chat", hasAutomation: false }, labels: [] },
  ] satisfies { name: string; facts: Partial<SidebarRecentSession>; labels: string[] }[])(
    "renders $name session facts without other metadata",
    ({ facts, labels }) => {
      const container = document.createElement("div");
      render(
        renderSessionHovercard({
          row: row({ createdActor: undefined, workContext: undefined, ...facts }),
        }),
        container,
      );

      const metadata = container.querySelector(".session-hovercard__section--metadata");
      expect(Boolean(metadata)).toBe(labels.length > 0);
      const contextRows = [...container.querySelectorAll(".session-hovercard__context-row")];
      expect(contextRows.map((context) => context.textContent?.trim())).toEqual(labels);
      expect(contextRows.map((context) => context.getAttribute("aria-label"))).toEqual(labels);
      for (const context of contextRows) {
        expect(
          context.querySelector('.session-hovercard__context-icon[aria-hidden="true"] svg'),
        ).not.toBeNull();
      }
    },
  );

  it("renders the channel avatar with gateway auth instead of an initials span", () => {
    const container = document.createElement("div");
    const channelAvatarUrl = "/__openclaw__/channel-avatar/agent%3Amain%3Awork";
    render(
      renderSessionHovercard({
        row: row({ channelAvatarUrl }),
        avatarAuth: {
          authTokens: ["device-token", "saved-token"],
          authReady: true,
        },
      }),
      container,
    );

    const avatar = container.querySelector<
      HTMLElement & {
        routeUrl: string;
        authTokens: readonly string[];
        authReady: boolean;
      }
    >("openclaw-channel-avatar.session-hovercard__creator-avatar");
    expect(avatar).not.toBeNull();
    expect(avatar?.routeUrl).toBe(channelAvatarUrl);
    expect(avatar?.authTokens).toEqual(["device-token", "saved-token"]);
    expect(avatar?.authReady).toBe(true);
    expect(container.querySelector("openclaw-viewer-avatar")).toBeNull();
  });

  it("keeps initials visible inside the channel avatar while auth is unavailable", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    render(
      renderSessionHovercard({
        row: row({ channelAvatarUrl: "/__openclaw__/channel-avatar/pending" }),
        avatarAuth: { authTokens: [], authReady: false },
      }),
      container,
    );

    await customElements.whenDefined("openclaw-channel-avatar");
    const avatar = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-channel-avatar",
    );
    await avatar?.updateComplete;

    await vi.waitFor(() => {
      expect(
        avatar?.querySelector(".session-hovercard__creator-avatar-fallback")?.textContent,
      ).toBe("AB");
    });
    expect(avatar?.querySelector("img.channel-avatar")).toBeNull();
    expect(container.querySelector("openclaw-viewer-avatar")).toBeNull();
  });

  it("shows the PR author beside the number and omits it for a ghosted account", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({
        pullRequests: snapshot({
          pullRequests: [
            {
              number: 201,
              owner: "openclaw",
              repo: "openclaw",
              branch: "feature",
              title: "Authored",
              url: "https://github.com/openclaw/openclaw/pull/201",
              state: "open",
              author: { login: "octocat" },
            },
            {
              number: 202,
              owner: "openclaw",
              repo: "openclaw",
              branch: "feature",
              title: "Ghosted",
              url: "https://github.com/openclaw/openclaw/pull/202",
              state: "merged",
            },
          ],
        }),
      }),
      container,
    );

    const links = [...container.querySelectorAll<HTMLAnchorElement>(".session-hovercard__pr-row")];
    expect(links[0]?.querySelector(".session-hovercard__pr-author")?.textContent?.trim()).toBe(
      "octocat",
    );
    expect(links[0]?.getAttribute("aria-label")).toContain("Opened by octocat");
    // A ghosted account keeps an empty author cell so the row geometry, and the
    // flush-right diff column, match an authored row.
    expect(links[1]?.querySelector(".session-hovercard__pr-author")?.textContent).toBe("");
    expect(links[1]?.querySelector(".session-hovercard__pr-author")?.hasAttribute("title")).toBe(
      false,
    );
    expect(links[1]?.getAttribute("aria-label")).not.toContain("Opened by");
  });

  it("renders bounded flat PR rows with accessible state, CI, and diff facts", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({
        pullRequests: snapshot({
          pullRequests: [
            {
              number: 101,
              owner: "openclaw",
              repo: "openclaw",
              branch: "feature",
              title: "First",
              url: "https://github.com/openclaw/openclaw/pull/101",
              state: "open",
              changedFiles: 2,
              additions: 7,
              deletions: 3,
              checks: { state: "passing", passed: 2, failed: 0, skipped: 0, running: 0 },
            },
            {
              number: 102,
              owner: "openclaw",
              repo: "openclaw",
              branch: "feature",
              title: "Second",
              url: "https://github.com/openclaw/openclaw/pull/102",
              state: "draft",
            },
            {
              number: 103,
              owner: "openclaw",
              repo: "openclaw",
              branch: "feature",
              title: "Third",
              url: "https://github.com/openclaw/openclaw/pull/103",
              state: "merged",
            },
            {
              number: 104,
              owner: "openclaw",
              repo: "openclaw",
              branch: "feature",
              title: "Fourth",
              url: "https://github.com/openclaw/openclaw/pull/104",
              state: "closed",
            },
            {
              number: 105,
              owner: "openclaw",
              repo: "openclaw",
              branch: "feature",
              title: "Fifth",
              url: "https://github.com/openclaw/openclaw/pull/105",
              state: "open",
            },
          ],
        }),
      }),
      container,
    );

    const links = [...container.querySelectorAll<HTMLAnchorElement>(".session-hovercard__pr-row")];
    expect(links).toHaveLength(4);
    expect(links[0]?.href).toBe("https://github.com/openclaw/openclaw/pull/101");
    expect(links[0]?.target).toBe("_blank");
    expect(links[0]?.rel).toContain("noopener");
    expect(links[0]?.querySelector(".session-hovercard__pr-number")?.textContent).toBe("#101");
    expect(
      links[0]?.querySelector(".session-hovercard__pr-state-icon")?.getAttribute("title"),
    ).toBe("Open · CI checks passing");
    expect(links[0]?.querySelector(".session-hovercard__pr-state-icon svg")).not.toBeNull();
    expect(links[0]?.querySelector(".session-hovercard__files")?.textContent).toBe("2 files");
    expect(links[0]?.querySelector(".session-hovercard__additions")?.textContent).toBe("+7");
    expect(links[0]?.querySelector(".session-hovercard__deletions")?.textContent).toBe("−3");
    expect(container.querySelector(".session-hovercard__more")?.textContent).toBe("+1 more");
    expect(container.querySelector(".session-hovercard__section--header")).toBeNull();
  });

  it("does not present a node-only subtitle as a project", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({ row: row({ subtitle: "macbook", workContext: undefined }) }),
      container,
    );

    expect(container.querySelector(".session-hovercard__section--metadata")).not.toBeNull();
    expect(container.querySelector(".session-hovercard__context-text")).toBeNull();
  });

  it("labels an authoritative non-repository cwd as a workspace", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({
        row: row({
          workContext: {
            kind: "workspace",
            name: "release-notes",
            path: "/workspaces/release-notes",
          },
        }),
      }),
      container,
    );

    const context = container.querySelector('[aria-label="Workspace: release-notes"]');
    expect(context?.getAttribute("aria-label")).toBe("Workspace: release-notes");
    expect(context?.getAttribute("title")).toBe("Workspace: /workspaces/release-notes");
    expect(context?.textContent).toContain("release-notes");
  });

  it("falls back to a flat branch row and spaced create-PR link", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({
        row: row({ workSession: true, subtitle: "openclaw/openclaw · feature" }),
        pullRequests: snapshot({
          branch: {
            owner: "openclaw",
            repo: "openclaw",
            branch: "feature",
            changedFiles: 3,
            additions: 12,
            deletions: 4,
            createUrl: "https://github.com/openclaw/openclaw/pull/new/feature",
          },
        }),
      }),
      container,
    );

    expect(container.querySelector(".session-hovercard__branch-name")?.textContent).toBe(
      "openclaw/openclaw · feature",
    );
    expect(container.querySelector(".session-hovercard__files")?.textContent).toBe("3 files");
    expect(container.querySelector(".session-hovercard__additions")?.textContent).toBe("+12");
    expect(container.querySelector(".session-hovercard__deletions")?.textContent).toBe("−4");
    const createLink = container.querySelector<HTMLAnchorElement>(".session-hovercard__no-pr a");
    expect(createLink?.textContent).toBe("Create PR");
    expect(createLink?.href).toBe("https://github.com/openclaw/openclaw/pull/new/feature");
  });

  it("renders the latest turn as plain text when progress is absent", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({
        row: row({ lastMessagePreview: "  Finished <strong>without markup</strong>.  " }),
      }),
      container,
    );

    expect(container.querySelector(".session-hovercard__excerpt")?.textContent).toBe(
      "Finished <strong>without markup</strong>.",
    );
    expect(container.querySelector(".session-hovercard__excerpt strong")).toBeNull();
    expect(container.querySelector(".session-progress-card")).toBeNull();
  });

  it("renders progress instead of the latest-turn excerpt", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({
        row: row({ lastMessagePreview: "This must not appear." }),
        progressCard: progressCard(),
      }),
      container,
    );

    expect(container.querySelector(".session-progress-card")?.textContent).toContain("Release");
    expect(
      container.querySelector(".session-hovercard__progress-footer:last-child"),
    ).not.toBeNull();
    expect(container.querySelector(".session-hovercard__excerpt")).toBeNull();
    expect(container.textContent).not.toContain("This must not appear.");
  });

  it("uses the session terminal status and endedAt for progress activity", () => {
    const container = document.createElement("div");
    const endedAt = Date.now() - 30_000;
    render(
      renderSessionHovercard({
        row: row({ status: "failed", endedAt }),
        progressCard: progressCard(),
      }),
      container,
    );

    expect(container.querySelector("time")?.textContent).toBe("Failed just now");
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
      new Date(endedAt).toISOString(),
    );
  });

  it("deduplicates creator and self from the compact participant identity", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({
        selfUserId: "self",
        row: row({
          participants: [
            { identity: { type: "profile", id: "alice" }, label: "Alice Baker" },
            { identity: { type: "profile", id: "self" }, label: "You" },
            { identity: { type: "profile", id: "mira" }, label: "Mira" },
            { identity: { type: "profile", id: "riley" }, label: "Riley" },
            { identity: { type: "profile", id: "mira" }, label: "Mira duplicate" },
          ],
          participantCount: 7,
        }),
      }),
      container,
    );

    expect(
      container
        .querySelector(".session-hovercard__identity-copy")
        ?.textContent?.replace(/\s+/gu, " ")
        .trim(),
    ).toBe("Alice Baker · with Mira, Riley +3");
    expect(
      container.querySelector(".session-hovercard__identity-row")?.getAttribute("aria-label"),
    ).toBe("Alice Baker, Mira, Riley 3 more participants");
  });

  it("opens the creator's activity feed from the identity row", () => {
    const container = document.createElement("div");
    const navigate = vi.fn();
    render(
      renderSessionHovercard({
        row: row(),
        personActivity: { basePath: "/ui", navigate },
      }),
      container,
    );

    const name = container.querySelector<HTMLAnchorElement>(".session-hovercard__identity-name");
    expect(name?.getAttribute("href")).toBe("/ui/activity?person=alice");
    expect(
      container.querySelector(".person-activity-avatar-link")?.getAttribute("aria-hidden"),
    ).toBe("true");

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    name?.dispatchEvent(click);
    expect(navigate).toHaveBeenCalledWith("alice");
    expect(click.defaultPrevented).toBe(true);
  });

  it("links every participant name while keeping the locale's list phrasing", () => {
    const container = document.createElement("div");
    const navigate = vi.fn();
    render(
      renderSessionHovercard({
        selfUserId: "self",
        row: row({
          participants: [
            { identity: { type: "profile", id: "self" }, label: "You" },
            { identity: { type: "profile", id: "mira" }, label: "Mira" },
            { identity: { type: "profile", id: "riley" }, label: "Riley" },
          ],
          participantCount: 5,
        }),
        personActivity: { basePath: "", navigate },
      }),
      container,
    );

    expect(
      container
        .querySelector(".session-hovercard__identity-copy")
        ?.textContent?.replace(/\s+/gu, " ")
        .trim(),
    ).toBe("Alice Baker · with Mira, Riley +2");
    const participantLinks = [
      ...container.querySelectorAll<HTMLAnchorElement>("a.session-hovercard__participant-name"),
    ];
    expect(participantLinks.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Mira", "/activity?person=mira"],
      ["Riley", "/activity?person=riley"],
    ]);

    participantLinks[1]?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(navigate).toHaveBeenCalledWith("riley");
  });

  it("keeps the identity plain text when no activity route is available", () => {
    const container = document.createElement("div");
    render(renderSessionHovercard({ row: row() }), container);

    expect(container.querySelector(".session-hovercard__identity-name")?.tagName).toBe("SPAN");
    expect(container.querySelector(".person-activity-avatar-link")).toBeNull();
  });

  it("keeps authoritative overflow when the participant projection is truncated", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({
        selfUserId: "self",
        row: row({
          participants: [
            { identity: { type: "profile", id: "mira" }, label: "Mira" },
            { identity: { type: "profile", id: "riley" }, label: "Riley" },
            { identity: { type: "profile", id: "sam" }, label: "Sam" },
            { identity: { type: "profile", id: "lee" }, label: "Lee" },
          ],
          participantCount: 5,
        }),
      }),
      container,
    );

    expect(container.querySelector(".session-hovercard__participants-more")?.textContent).toBe(
      "+2",
    );
  });

  it("renders nothing when no session facts are known", () => {
    const container = document.createElement("div");
    render(renderSessionHovercard({}), container);

    expect(container.childElementCount).toBe(0);
  });
});
