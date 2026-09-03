#!/usr/bin/env node
import path from "node:path";
import { chromium, type Page } from "playwright";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { readControlUiProofOption } from "./lib/control-ui-proof-args.mts";
type CaptureMode = "after" | "before";

function readMode(): CaptureMode {
  const value = readControlUiProofOption(process.argv, "mode") ?? "after";
  if (value !== "after" && value !== "before") {
    throw new Error(`Expected --mode after|before, received ${value}`);
  }
  return value;
}

function sessionRow(
  key: string,
  label: string,
  updatedAt: number,
  extra: Record<string, unknown> = {},
) {
  return {
    contextTokens: 200_000,
    displayName: label,
    hasActiveRun: false,
    key,
    kind: "direct",
    label,
    model: "gpt-5.6-luna",
    modelProvider: "openai",
    status: "done",
    totalTokens: 0,
    updatedAt,
    ...extra,
  };
}

function sessionsListResponse(sessions: unknown[]) {
  return {
    count: sessions.length,
    defaults: {
      contextTokens: 200_000,
      model: "gpt-5.6-luna",
      modelProvider: "openai",
    },
    hasMore: false,
    limitApplied: 50,
    nextOffset: null,
    offset: 0,
    path: "",
    sessions,
    totalCount: sessions.length,
    ts: Date.parse("2026-08-17T20:00:00.000Z"),
  };
}

const baseTime = Date.parse("2026-08-17T20:00:00.000Z");
const groupedSessions = [
  sessionRow("agent:main:main", "Main", baseTime),
  sessionRow("agent:main:jesse-roadmap", "Roadmap review", baseTime - 60_000, {
    category: "Jesse",
  }),
  sessionRow("agent:main:jesse-launch", "Launch checklist", baseTime - 120_000, {
    category: "Jesse",
  }),
  sessionRow("agent:main:josh-design", "Design handoff", baseTime - 180_000, {
    category: "Josh",
  }),
  sessionRow("agent:main:josh-feedback", "Customer feedback", baseTime - 240_000, {
    category: "Josh",
  }),
  sessionRow("agent:main:weekly-planning", "Weekly planning", baseTime - 300_000),
  sessionRow("agent:main:travel-notes", "Travel notes", baseTime - 360_000),
  sessionRow("agent:main:reading-list", "Reading list", baseTime - 420_000),
  sessionRow("agent:main:toolbar-cleanup", "Toolbar cleanup", baseTime - 480_000, {
    worktree: {
      branch: "feat/session-toolbar",
      id: "wt-session-toolbar",
      repoRoot: "/Users/demo/Projects/openclaw",
    },
  }),
  sessionRow("agent:main:filter-followup", "Filter menu follow-up", baseTime - 540_000, {
    worktree: {
      branch: "fix/filter-menu",
      id: "wt-filter-menu",
      repoRoot: "/Users/demo/Projects/openclaw",
    },
  }),
];

const ungroupedSessions = [
  sessionRow("agent:main:main", "Main", baseTime),
  sessionRow("agent:main:weekly-planning", "Weekly planning", baseTime - 60_000),
  sessionRow("agent:main:travel-notes", "Travel notes", baseTime - 120_000),
  sessionRow("agent:main:reading-list", "Reading list", baseTime - 180_000),
];

const mode = readMode();
const outputDir = createControlUiE2eArtifactDir(
  "session-toolbar-proof",
  readControlUiProofOption(process.argv, "output-dir") ??
    ".artifacts/control-ui-e2e/session-toolbar-proof",
);
const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
if (!canRunPlaywrightChromium(executablePath)) {
  throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
}

const server = await startControlUiE2eServer(undefined, { source: true });
const browser = await chromium.launch({ executablePath });
const captured: string[] = [];

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

async function capture(page: Page, name: string): Promise<void> {
  await settle(page);
  const target = path.join(outputDir, name);
  await page.screenshot({
    animations: "disabled",
    clip: { x: 0, y: 0, width: 560, height: 900 },
    path: target,
  });
  captured.push(target);
}

async function openScenario(sessions: unknown[], groups: string[] = []) {
  const context = await browser.newContext({
    colorScheme: "dark",
    locale: "en-US",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await installMockGateway(page, {
    methodResponses: {
      "sessions.list": sessionsListResponse(sessions),
    },
    sessionArchiveFiltering: true,
    sessionGroups: groups,
    sessionKey: "agent:main:main",
  });
  await page.goto(`${server.baseUrl}chat`);
  await page.locator("openclaw-app-sidebar").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  return { context, page };
}

async function expandCoding(page: Page): Promise<void> {
  const coding = page.locator('[data-session-section="work"]');
  await coding.waitFor({ state: "visible" });
  const toggle = coding.getByRole("button", { name: "Coding", exact: true });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-session-section="work"] .sidebar-recent-session').length ===
      2,
  );
}

try {
  if (mode === "after") {
    const grouped = await openScenario(groupedSessions, ["Jesse", "Josh"]);
    try {
      await grouped.page.waitForFunction(() => {
        const counts = ["Jesse", "Josh"].map(
          (name) =>
            document.querySelectorAll(
              `[data-session-section="category:${name}"] .sidebar-recent-session`,
            ).length,
        );
        return counts.every((count) => count === 2);
      });
      await grouped.page.waitForFunction(
        () =>
          document.querySelectorAll('[data-session-section="ungrouped"] .sidebar-recent-session')
            .length === 3,
      );
      await expandCoding(grouped.page);

      const toolbar = grouped.page.locator(".sidebar-session-toolbar");
      await toolbar.getByText("Sessions", { exact: true }).waitFor();
      const filter = toolbar.getByRole("button", { name: "Filter & sort" });
      const add = toolbar.getByRole("button", { name: "New session" });
      await grouped.page.mouse.move(1_000, 850);
      const toolbarOpacity = await Promise.all([
        filter.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity)),
        add.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity)),
      ]);
      if (toolbarOpacity.some((opacity) => opacity <= 0)) {
        throw new Error(
          `Toolbar controls are not visible without hover: ${toolbarOpacity.join(", ")}`,
        );
      }
      await grouped.page.getByText("Other", { exact: true }).waitFor();
      await capture(grouped.page, "after-grouped.png");

      await filter.click();
      await grouped.page.locator(".sidebar-session-sort-menu").waitFor({ state: "visible" });
      await capture(grouped.page, "after-toolbar-menu.png");

      await grouped.page.getByRole("menuitemradio", { name: "All", exact: true }).click();
      await grouped.page.waitForFunction(
        () =>
          document
            .querySelector(".sidebar-session-toolbar .sidebar-session-sort")
            ?.classList.contains("sidebar-session-sort--filtered") === true,
      );
      await grouped.page.mouse.move(1_000, 850);
      await capture(grouped.page, "after-filter-active.png");
    } finally {
      await grouped.context.close();
    }

    const ungrouped = await openScenario(ungroupedSessions);
    try {
      await ungrouped.page.waitForFunction(
        () =>
          document.querySelectorAll('[data-session-section="ungrouped"] .sidebar-recent-session')
            .length === 3,
      );
      if (
        (await ungrouped.page
          .locator('[data-session-section="ungrouped"] > .sidebar-recent-sessions__head')
          .count()) !== 0
      ) {
        throw new Error("Ungrouped-only state unexpectedly rendered a section header");
      }
      await ungrouped.page.getByText("Sessions", { exact: true }).waitFor();
      await capture(ungrouped.page, "after-ungrouped-only.png");
    } finally {
      await ungrouped.context.close();
    }
  } else {
    const grouped = await openScenario(groupedSessions, ["Jesse", "Josh"]);
    try {
      await grouped.page.waitForFunction(
        () =>
          document.querySelectorAll('[data-session-section="ungrouped"] .sidebar-recent-session')
            .length === 3,
      );
      await expandCoding(grouped.page);
      const header = grouped.page.locator(
        '[data-session-section="ungrouped"] > .sidebar-recent-sessions__head',
      );
      const filter = header.getByRole("button", { name: "Sort sessions" });
      const add = header.getByRole("button", { name: "New session" });

      await grouped.page.mouse.move(1_000, 850);
      await settle(grouped.page);
      const idleOpacity = await Promise.all([
        filter.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity)),
        add.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity)),
      ]);
      if (idleOpacity.some((opacity) => opacity !== 0)) {
        throw new Error(`Legacy controls are not hover-hidden: ${idleOpacity.join(", ")}`);
      }
      await capture(grouped.page, "before-grouped.png");

      await header.hover();
      await grouped.page.waitForFunction(() => {
        const controls = [
          ...document.querySelectorAll(
            '[data-session-section="ungrouped"] > .sidebar-recent-sessions__head .sidebar-session-group-actions',
          ),
        ];
        return (
          controls.length === 2 &&
          controls.every((element) => getComputedStyle(element).opacity === "1")
        );
      });
      await capture(grouped.page, "before-grouped-hover.png");
    } finally {
      await grouped.context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(
  JSON.stringify({ captured, fixture: "custom installMockGateway scenario", mode }, null, 2),
);
