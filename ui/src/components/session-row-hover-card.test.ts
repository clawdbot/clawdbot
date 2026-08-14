/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import {
  renderCatalogSessionInformationCard,
  renderSessionInformationCard,
} from "./session-row-hover-card.ts";

let container: HTMLDivElement;

beforeEach(async () => {
  await i18n.setLocale("en");
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  container.remove();
});

function sidebarSession(overrides: Partial<SidebarRecentSession> = {}): SidebarRecentSession {
  return {
    key: "agent:main:one",
    label: "One",
    kind: "direct",
    href: "/chat",
    active: false,
    visuallyActive: false,
    hasActiveRun: false,
    pinned: false,
    unread: false,
    attention: { kind: "none" },
    cloudWorkerStopAction: null,
    hasAutomation: false,
    updatedAt: Date.now() - 7_200_000,
    childSessionKeys: [],
    children: [],
    isChild: false,
    loadingChildren: false,
    containsActiveDescendant: false,
    runningChildCount: 0,
    failedChildCount: 0,
    ...overrides,
  } as SidebarRecentSession;
}

function renderCard(overrides: Partial<SidebarRecentSession> = {}, owner?: { label: string }) {
  render(
    renderSessionInformationCard({
      session: sidebarSession(overrides),
      title: "Reconcile the workspace conflict",
      owner: owner ? { type: "human", id: "profile-ada", label: owner.label } : undefined,
      attribution: "created",
    }),
    container,
  );
  return container;
}

function rowTexts(): string[] {
  return [...container.querySelectorAll(".session-hover-card__row")].map((row) =>
    (row.textContent ?? "").replace(/\s+/gu, " ").trim(),
  );
}

describe("session information card", () => {
  it("leads with the full title and the session age", () => {
    renderCard();

    expect(container.querySelector(".session-hover-card__title")?.textContent).toBe(
      "Reconcile the workspace conflict",
    );
    expect(container.querySelector(".session-hover-card__age")?.textContent?.trim()).toBeTruthy();
  });

  it("collapses to the header alone when the session has no other facts", () => {
    renderCard();

    expect(rowTexts()).toEqual([]);
    expect(container.querySelector(".session-hover-card__divider")).toBeNull();
  });

  it("derives the project from a checkout, then from the working directory", () => {
    renderCard({
      worktree: { id: "wt-1", branch: "feature/sidebar", repoRoot: "/Users/ada/code/openclaw" },
    });
    expect(rowTexts()).toEqual(["Project /Users/ada/code/openclaw", "Branch feature/sidebar"]);

    renderCard({ execCwd: "/Users/ada/scratch" });
    expect(rowTexts()).toEqual(["Project /Users/ada/scratch"]);
  });

  it("names the creator only when the caller says attribution is on screen", () => {
    renderCard({ createdActor: { type: "human", id: "profile-ada", label: "Ada" } });
    expect(rowTexts()).toEqual([]);

    renderCard(
      { createdActor: { type: "human", id: "profile-ada", label: "Ada" } },
      {
        label: "Ada",
      },
    );
    expect(rowTexts()).toEqual(["Created by Ada"]);
  });

  it("never repeats row state the reader can already see", () => {
    renderCard({ unread: true, hasActiveRun: true, attention: { kind: "error", reason: "boom" } });

    expect(rowTexts()).toEqual([]);
  });

  it("states a workspace conflict as danger and healthy placement as context", () => {
    renderCard({ placementState: "active" });
    expect(rowTexts()).toEqual(["Cloud worker: active"]);
    expect(container.querySelector(".session-hover-card__row--danger")).toBeNull();

    renderCard({ placementState: "active", workspaceConflictCount: 3 });
    expect(rowTexts()).toEqual(["Cloud worker: active · 3 workspace conflicts"]);
    expect(container.querySelector(".session-hover-card__row--danger")).not.toBeNull();

    renderCard({ placementState: "failed" });
    expect(container.querySelector(".session-hover-card__row--danger")).not.toBeNull();
  });

  it("keeps a local session out of the cloud vocabulary", () => {
    renderCard({ placementState: "local" });

    expect(rowTexts()).toEqual([]);
  });

  it("reports draft, incognito, and pull-request context from real fields", () => {
    renderCard({
      visibility: "draft",
      incognito: true,
      pullRequest: { numbers: [12, 13], state: "open" },
    });

    expect(rowTexts()).toEqual([
      "Draft Keep this session to yourself until you publish it",
      "Incognito Keep this session only until the Gateway restarts",
      "#12, #13 · Open",
    ]);
  });

  it("gives a catalog session the same anatomy from the facts it has", () => {
    render(
      renderCatalogSessionInformationCard({
        title: "Refactor sidebar",
        age: "3d",
        cwd: "/Users/ada/code/clawhub",
        branch: "main",
      }),
      container,
    );

    expect(container.querySelector(".session-hover-card__age")?.textContent).toBe("3d");
    expect(rowTexts()).toEqual(["Project /Users/ada/code/clawhub", "Branch main"]);

    render(renderCatalogSessionInformationCard({ title: "Loose", age: "" }), container);
    expect(rowTexts()).toEqual([]);
    expect(container.querySelector(".session-hover-card__age")).toBeNull();
  });
});
