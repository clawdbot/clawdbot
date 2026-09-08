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
    hasActiveRun: true,
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

function attributionSummary(container: ParentNode): string {
  return [
    container.querySelector(".session-hovercard__attribution-name")?.textContent,
    container.querySelector(".session-hovercard__attribution-others")?.textContent,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

describe("renderSessionHovercard", () => {
  it.each(["purple", undefined, "default"])(
    "reflects the session color %s without unset chrome",
    (color) => {
      const container = document.createElement("div");
      render(renderSessionHovercard({ row: row({ color }) }), container);
      const dot = container.querySelector(".session-color-dot");
      if (color === "purple") {
        expect(dot?.getAttribute("aria-label")).toBe("Session color: Purple");
        expect(dot?.getAttribute("style")).toContain("--session-color-purple");
      } else {
        expect(dot).toBeNull();
      }
    },
  );

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
    expect(container.querySelector(".session-hovercard__created-age")?.textContent).toBe("2h");
    expect(container.querySelector(".session-hovercard__meta")).toBeNull();
    expect(container.querySelector(".session-hovercard__attribution")?.textContent).toContain(
      "Alice Baker",
    );
    expect(
      [...container.querySelectorAll(".session-hovercard__context-text")].map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["openclaw"]);
    expect(
      [...container.querySelectorAll(".session-hovercard__section")].map((section) =>
        [...section.classList].find((name) => name.startsWith("session-hovercard__section--")),
      ),
    ).toEqual(["session-hovercard__section--header", "session-hovercard__section--metadata"]);
    expect(container.querySelector(".session-progress-card")).toBeNull();
    expect(container.querySelector(".session-hovercard__excerpt")).toBeNull();
  });

  it.each([
    { name: "dashboard", facts: { boardFace: "dashboard" }, labels: ["Opens as dashboard"] },
    { name: "automation", facts: { hasAutomation: true }, labels: ["Automation attached"] },
    {
      name: "both",
      facts: { boardFace: "dashboard", hasAutomation: true },
      labels: ["Opens as dashboard", "Automation attached"],
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

  it("renders one titled PR row with compact diff facts and an overflow count", () => {
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
          ],
        }),
      }),
      container,
    );

    const links = [...container.querySelectorAll<HTMLAnchorElement>(".session-hovercard__pr-row")];
    expect(links).toHaveLength(1);
    expect(links[0]?.href).toBe("https://github.com/openclaw/openclaw/pull/101");
    expect(links[0]?.target).toBe("_blank");
    expect(links[0]?.rel).toContain("noopener");
    expect(links[0]?.querySelector(".session-hovercard__pr-title")?.textContent).toBe("First");
    expect(
      links[0]?.querySelector(".session-hovercard__pr-title")?.getAttribute("title"),
    ).toBeNull();
    expect(links[0]?.querySelector(".session-hovercard__pr-number")).toBeNull();
    expect(links[0]?.querySelector(".session-hovercard__pr-author")).toBeNull();
    expect(
      links[0]?.querySelector(".session-hovercard__pr-state-icon")?.getAttribute("title"),
    ).toBe("Open · CI checks passing");
    expect(links[0]?.querySelector(".session-hovercard__pr-state-icon svg")).not.toBeNull();
    expect(links[0]?.querySelector(".session-hovercard__files")).toBeNull();
    expect(links[0]?.querySelector(".session-hovercard__additions")?.textContent).toBe("+7");
    expect(links[0]?.querySelector(".session-hovercard__deletions")?.textContent).toBe("−3");
    expect(links[0]?.getAttribute("aria-label")).toContain("First");
    expect(links[0]?.getAttribute("aria-label")).not.toContain("Opened by");
    expect(links[0]?.getAttribute("aria-label")).not.toContain("files");
    expect(container.querySelector(".session-hovercard__more")?.textContent).toBe("+2 more");
    expect(container.querySelector(".session-hovercard__section--header")).toBeNull();
  });

  it("does not present a node-only subtitle as project metadata", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({ row: row({ subtitle: "macbook", workContext: undefined }) }),
      container,
    );

    expect(container.querySelector(".session-hovercard__section--metadata")).toBeNull();
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

  it("renders a compact create-PR row without exposing the branch name", () => {
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

    expect(container.querySelector(".session-hovercard__branch-name")).toBeNull();
    expect(container.querySelector(".session-hovercard__files")).toBeNull();
    expect(container.querySelector(".session-hovercard__additions")?.textContent).toBe("+12");
    expect(container.querySelector(".session-hovercard__deletions")?.textContent).toBe("−4");
    const createLink = container.querySelector<HTMLAnchorElement>(
      ".session-hovercard__branch-action",
    );
    expect(createLink?.textContent).toBe("Create PR");
    expect(createLink?.href).toBe("https://github.com/openclaw/openclaw/pull/new/feature");
    expect(createLink?.title).toBe("Create a pull request for feature");
  });

  it("labels local diff facts without exposing an unpushable branch", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({
        pullRequests: snapshot({
          branch: {
            owner: "openclaw",
            repo: "openclaw",
            branch: "local-only",
            changedFiles: 2,
            additions: 18,
            deletions: 1,
          },
        }),
      }),
      container,
    );

    expect(container.querySelector(".session-hovercard__branch-name")).toBeNull();
    expect(container.querySelector(".session-hovercard__branch-action")).toBeNull();
    expect(container.querySelector(".session-hovercard__branch-label")?.textContent).toBe(
      "Changes",
    );
    expect(container.querySelector(".session-hovercard__additions")?.textContent).toBe("+18");
    expect(container.querySelector(".session-hovercard__deletions")?.textContent).toBe("−1");
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

  it("places current work with session facts and keeps markdown in Agent Notepad", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({
        row: row({ lastMessagePreview: "This must not appear." }),
        progressCard: progressCard(),
      }),
      container,
    );

    const plan = container.querySelector(".session-hovercard__plan-row");
    expect(plan?.querySelector(".session-hovercard__plan-step")?.textContent).toBe("Verify");
    expect(plan?.querySelector(".session-hovercard__plan-count")?.textContent).toBe("0/1");
    expect(plan?.querySelector(".session-run-spinner")).not.toBeNull();
    const notepad = container.querySelector(".session-hovercard__notepad");
    expect(notepad?.querySelector(".session-hovercard__notepad-title")?.textContent).toBe(
      "Agent Notepad",
    );
    expect(notepad?.querySelector("strong")?.textContent).toBe("Release");
    expect(container.querySelector(".session-progress-card")).toBeNull();
    expect(container.querySelector("time")).toBeNull();
    expect(container.querySelector(".session-hovercard__excerpt")).toBeNull();
    expect(container.textContent).not.toContain("This must not appear.");
  });

  it.each([
    { hasActiveRun: true, updateOffset: -1 },
    { hasActiveRun: false, updateOffset: 1 },
  ])("pauses unfinished progress with run state %j", ({ hasActiveRun, updateOffset }) => {
    const container = document.createElement("div");
    const startedAt = Date.now();
    render(
      renderSessionHovercard({
        row: row({ startedAt, status: "running", hasActiveRun }),
        progressCard: { ...progressCard(), updatedAt: startedAt + updateOffset },
      }),
      container,
    );

    const plan = container.querySelector(".session-hovercard__plan-row");
    expect(plan?.getAttribute("aria-label")).toBe("Verify, paused");
    expect(plan?.querySelector(".session-run-spinner")).toBeNull();
    expect(plan?.querySelector("polyline")).not.toBeNull();
  });

  it("keeps an older progress card paused after the later run ends", () => {
    const container = document.createElement("div");
    const startedAt = Date.now();
    render(
      renderSessionHovercard({
        row: row({ startedAt, status: "done" }),
        progressCard: { ...progressCard(), updatedAt: startedAt - 1 },
      }),
      container,
    );

    const plan = container.querySelector(".session-hovercard__plan-row");
    expect(plan?.getAttribute("aria-label")).toBe("Verify, paused");
    expect(plan?.querySelector(".session-run-spinner")).toBeNull();
  });

  it("pins a labeled markdown progress bar above the Agent Notepad copy", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({
        row: row(),
        progressCard: {
          ...progressCard(),
          markdown:
            '**Build is healthy.**\n\n<progress aria-label="CI · 4/6" value="4" max="6"></progress>\n\nWaiting on Windows.',
        },
      }),
      container,
    );

    const markdown = container.querySelector(".session-progress-card__markdown");
    const promoted = markdown?.firstElementChild;
    expect(promoted?.classList.contains("session-progress-card__progress")).toBe(true);
    expect(promoted?.querySelector(".session-progress-card__progress-label")?.textContent).toBe(
      "CI · 4/6",
    );
    expect(promoted?.querySelector("progress")?.getAttribute("value")).toBe("4");
    expect(markdown?.textContent).toContain("Build is healthy.");
    expect(markdown?.textContent).toContain("Waiting on Windows.");
  });

  it("renders a markdown-only Agent Notepad without inventing plan metadata", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({
        row: row(),
        progressCard: { ...progressCard(), steps: undefined },
      }),
      container,
    );

    expect(container.querySelector(".session-hovercard__plan-row")).toBeNull();
    expect(container.querySelector(".session-hovercard__notepad strong")?.textContent).toBe(
      "Release",
    );
  });

  it("shows the first active step, otherwise the first pending step, and never completed work", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({
        row: row(),
        progressCard: {
          ...progressCard(),
          markdown: undefined,
          steps: [
            { step: "Done", status: "completed" },
            { step: "Next", status: "pending" },
            { step: "Working", status: "in_progress" },
            { step: "Later", status: "pending" },
          ],
        },
      }),
      container,
    );
    expect(container.querySelector(".session-hovercard__plan-step")?.textContent).toBe("Working");
    expect(container.querySelector(".session-hovercard__plan-count")?.textContent).toBe("1/4");
    expect(container.querySelector(".session-hovercard__notepad")).toBeNull();

    render(
      renderSessionHovercard({
        row: row(),
        progressCard: {
          ...progressCard(),
          markdown: undefined,
          steps: [
            { step: "Done", status: "completed" },
            { step: "Next", status: "pending" },
            { step: "Later", status: "pending" },
          ],
        },
      }),
      container,
    );
    expect(container.querySelector(".session-hovercard__plan-step")?.textContent).toBe("Next");
    expect(container.querySelector(".session-hovercard__plan-count")?.textContent).toBe("1/3");

    render(
      renderSessionHovercard({
        row: row(),
        progressCard: {
          ...progressCard(),
          markdown: undefined,
          steps: [{ step: "Done", status: "completed" }],
        },
      }),
      container,
    );
    expect(container.querySelector(".session-hovercard__plan-row")).toBeNull();
    expect(container.querySelector(".session-hovercard__notepad")).toBeNull();
  });

  it.each(["done", "failed", "timeout", "killed"] as const)(
    "hides plan work updated during the run after the session is %s",
    (status) => {
      const container = document.createElement("div");
      render(
        renderSessionHovercard({
          row: row({ status }),
          progressCard: progressCard(),
        }),
        container,
      );

      expect(container.querySelector(".session-hovercard__plan-row")).toBeNull();
      expect(container.querySelector(".session-hovercard__notepad")).not.toBeNull();
    },
  );

  it("deduplicates creator and self from the compact attribution", () => {
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

    expect(attributionSummary(container)).toBe("Alice Baker & 5 others");
    expect(
      container.querySelector(".session-hovercard__attribution")?.getAttribute("aria-label"),
    ).toBe("Alice Baker, 5 more participants");
  });

  it("opens the creator's activity feed from the attribution", () => {
    const container = document.createElement("div");
    const navigate = vi.fn();
    render(
      renderSessionHovercard({
        row: row(),
        personActivity: { basePath: "/ui", navigate },
      }),
      container,
    );

    const name = container.querySelector<HTMLAnchorElement>(".session-hovercard__attribution-name");
    expect(name?.getAttribute("href")).toBe("/ui/activity/alice");
    expect(
      container.querySelector(".person-activity-avatar-link")?.getAttribute("aria-hidden"),
    ).toBe("true");

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    name?.dispatchEvent(click);
    expect(navigate).toHaveBeenCalledWith("alice", "Alice Baker");
    expect(click.defaultPrevented).toBe(true);
  });

  it("links participant avatars while keeping the creator first", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    const navigate = vi.fn();
    render(
      renderSessionHovercard({
        selfUserId: "self",
        row: row({
          participants: [
            { identity: { type: "profile", id: "self" }, label: "You" },
            { identity: { type: "profile", id: "mira" }, label: "Mira" },
            { identity: { type: "profile", id: "riley" }, label: "Riley" },
            { identity: { type: "profile", id: "sam" }, label: "Sam" },
          ],
          expandedParticipants: [
            { identity: { type: "profile", id: "self" }, label: "You" },
            { identity: { type: "profile", id: "mira" }, label: "Mira" },
            { identity: { type: "profile", id: "riley" }, label: "Riley" },
            { identity: { type: "profile", id: "sam" }, label: "Sam" },
            { identity: { type: "profile", id: "lee" }, label: "Lee" },
          ],
          participantCount: 5,
        }),
        personActivity: { basePath: "", navigate },
      }),
      container,
    );

    expect(attributionSummary(container)).toBe("Alice Baker & 4 others");
    const facepile = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-viewer-facepile",
    );
    await facepile?.updateComplete;
    const participantLinks = [
      ...container.querySelectorAll<HTMLAnchorElement>("openclaw-viewer-facepile a"),
    ];
    expect(participantLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/activity/mira",
      "/activity/riley",
      "/activity/sam",
      "/activity/lee",
    ]);

    const participantsTooltip = container.querySelector<
      HTMLElement & { updateComplete: Promise<boolean> }
    >("openclaw-tooltip.session-hovercard__participants-tooltip");
    await participantsTooltip?.updateComplete;
    expect(participantsTooltip?.hasAttribute("open-on-click")).toBe(true);
    const participantTrigger = participantsTooltip?.querySelector<HTMLButtonElement>(
      ".session-hovercard__attribution-others",
    );
    const touchDown = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(touchDown, "pointerType", { value: "touch" });
    participantTrigger?.dispatchEvent(touchDown);
    participantTrigger?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    participantTrigger?.click();
    expect(participantsTooltip?.hasAttribute("open")).toBe(true);
    expect(participantTrigger?.textContent).toContain("4 others");
    expect(
      [
        ...(participantsTooltip?.querySelectorAll<HTMLAnchorElement>(
          ".session-hovercard__participant-link",
        ) ?? []),
      ].map((link) => link.getAttribute("href")),
    ).toEqual(["/activity/mira", "/activity/riley", "/activity/sam", "/activity/lee"]);

    participantLinks[1]?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(navigate).toHaveBeenCalledWith("riley", "Riley");

    participantsTooltip
      ?.querySelector<HTMLAnchorElement>('.session-hovercard__participant-link[href$="lee"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(navigate).toHaveBeenLastCalledWith("lee", "Lee");
  });

  it("uses the first participant as the attribution when the creator is unknown", () => {
    const container = document.createElement("div");
    render(
      renderSessionHovercard({
        selfUserId: "self",
        row: row({
          createdActor: undefined,
          participants: [
            { identity: { type: "profile", id: "self" }, label: "You" },
            { identity: { type: "profile", id: "mira" }, label: "Mira" },
            { identity: { type: "profile", id: "riley" }, label: "Riley" },
          ],
          participantCount: 5,
        }),
      }),
      container,
    );

    expect(attributionSummary(container)).toBe("Mira & 3 others");
  });

  it("keeps the identity plain text when no activity route is available", () => {
    const container = document.createElement("div");
    render(renderSessionHovercard({ row: row() }), container);

    expect(container.querySelector(".session-hovercard__attribution-name")?.tagName).toBe("SPAN");
    expect(container.querySelector(".person-activity-avatar-link")).toBeNull();
  });

  it("keeps authoritative overflow when the participant projection is truncated", async () => {
    const container = document.body.appendChild(document.createElement("div"));
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

    const facepile = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-viewer-facepile",
    );
    await facepile?.updateComplete;
    expect(facepile?.querySelectorAll(".viewer-avatar:not(.viewer-avatar--overflow)")).toHaveLength(
      4,
    );
    expect(facepile?.querySelector(".viewer-avatar--overflow")?.textContent).toBe("+1");
  });

  it("renders nothing when no session facts are known", () => {
    const container = document.createElement("div");
    render(renderSessionHovercard({}), container);

    expect(container.childElementCount).toBe(0);
  });
});
