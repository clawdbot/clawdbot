import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
const captureBaseline = process.env.OPENCLAW_CAPTURE_UI_BASELINE === "1";

async function capture(target: Locator | Page, fileName: string) {
  if (!artifactRoot) {
    return;
  }
  await mkdir(artifactRoot, { recursive: true });
  await target.screenshot({
    animations: "disabled",
    path: path.join(artifactRoot, fileName),
  });
}

function transcriptMessage(seq: number, role: "assistant" | "user", text: string) {
  return {
    __openclaw: { id: `topbar-proof-${seq}`, seq },
    content: [{ text, type: role === "assistant" ? "output_text" : "input_text" }],
    role,
    timestamp: 1_800_000_000_000 + seq,
  };
}

suite.define(() => {
  for (const colorScheme of ["light", "dark"] as const) {
    it(`moves plain-web navigation controls between sidebar and chat headers in ${colorScheme} mode`, async () => {
      const context = await suite.newBrowserContext({
        colorScheme,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      });
      const page = await context.newPage();
      await installMockGateway(page, {
        assistantName: "Roboclaw",
        historyMessages: [
          transcriptMessage(
            1,
            "user",
            "Can you review the release checklist and call out anything still blocking the team?",
          ),
          transcriptMessage(
            2,
            "assistant",
            "I checked the current plan. The release notes are ready, the integration suite is green, and the only remaining item is confirming the macOS signing artifact.",
          ),
          transcriptMessage(
            3,
            "user",
            "Keep the summary concise and leave the detailed evidence in the workboard.",
          ),
          transcriptMessage(
            4,
            "assistant",
            "Done. I added the evidence to the workboard and kept the operator summary focused on the single open gate.",
          ),
        ],
        methodResponses: {
          "sessions.list": chatSessionListResponse([
            {
              key: "agent:main:release-readiness",
              kind: "direct",
              label: "Release readiness review",
              spawnedCwd: "/repo/openclaw",
              updatedAt: 4,
            },
            {
              key: "agent:main:control-ui-polish",
              kind: "direct",
              label: "Control UI polish follow-ups",
              updatedAt: 3,
            },
            {
              key: "agent:main:gateway-regression",
              kind: "direct",
              label: "Gateway regression investigation",
              updatedAt: 2,
            },
            {
              key: "agent:main:documentation-pass",
              kind: "direct",
              label: "Documentation consistency pass",
              updatedAt: 1,
            },
          ]),
        },
        sessionKey: "agent:main:release-readiness",
        workspaceGit: true,
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const sidebarHeader = page.locator(".sidebar-brand");
        const sidebarActions = sidebarHeader.locator(".sidebar-brand__actions");
        const collapse = sidebarActions.locator(".sidebar-brand__collapse");
        const search = sidebarActions.locator(".sidebar-brand__search");
        const shellControls = page.locator(".shell-chrome-controls");
        await sidebarHeader.waitFor({ state: "visible" });
        if (captureBaseline) {
          await capture(page, `before-open-${colorScheme}-context.png`);
          await capture(sidebarHeader, `before-open-${colorScheme}-sidebar-crop.png`);
          await capture(shellControls, `before-open-${colorScheme}-topbar-crop.png`);
          await shellControls.locator(".shell-chrome-controls__nav-toggle").click();
          await expect
            .poll(() => page.locator(".shell").getAttribute("class"))
            .toContain("shell--nav-collapsed");
          await capture(page, `before-closed-${colorScheme}-context.png`);
          await capture(shellControls, `before-closed-${colorScheme}-crop.png`);
          return;
        }
        await expect.poll(() => sidebarActions.getByRole("button").count()).toBe(3);
        await expect.poll(() => shellControls.count()).toBe(0);
        await expect.poll(() => search.getAttribute("aria-label")).toBe("Open command palette");
        await expect.poll(() => collapse.getAttribute("aria-label")).toBe("Collapse sidebar");
        await expect
          .poll(() =>
            collapse.evaluate((element) => {
              const style = getComputedStyle(element);
              return { background: style.backgroundColor, border: style.borderStyle };
            }),
          )
          .toEqual({ background: "rgba(0, 0, 0, 0)", border: "none" });

        await capture(page, `after-open-${colorScheme}-context.png`);
        await capture(sidebarHeader, `after-open-${colorScheme}-crop.png`);

        await search.hover();
        await capture(sidebarHeader, `after-hover-${colorScheme}-crop.png`);
        await collapse.focus();
        await capture(sidebarHeader, `after-focus-${colorScheme}-crop.png`);

        await collapse.click();
        const expand = shellControls.locator(".shell-chrome-controls__nav-toggle");
        const separator = shellControls.locator(".shell-chrome-controls__separator");
        await expect.poll(() => expand.isVisible()).toBe(true);
        await expect.poll(() => separator.isVisible()).toBe(true);
        await expect.poll(() => shellControls.getByRole("button").count()).toBe(1);
        await expect
          .poll(() =>
            expand.evaluate((element) => {
              const style = getComputedStyle(element);
              return { background: style.backgroundColor, border: style.borderStyle };
            }),
          )
          .toEqual({ background: "rgba(0, 0, 0, 0)", border: "none" });
        await page.mouse.move(720, 700);
        await page.locator(".content").focus();
        await expect
          .poll(() => expand.evaluate((element) => document.activeElement === element))
          .toBe(false);
        await capture(page, `after-closed-${colorScheme}-context.png`);
        await capture(
          page.locator(".chat-pane__header").first(),
          `after-closed-${colorScheme}-crop.png`,
        );
      } finally {
        await suite.closeBrowserContext(context);
      }
    });

    it(`keeps the unavailable new-session action distinct in ${colorScheme} mode`, async () => {
      const context = await suite.newBrowserContext({
        colorScheme,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      });
      const page = await context.newPage();
      await installMockGateway(page, {
        assistantName: "Roboclaw",
        operatorScopes: ["operator.read"],
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        if (captureBaseline) {
          return;
        }
        const sidebarHeader = page.locator(".sidebar-brand");
        const create = sidebarHeader.locator(".sidebar-brand__new-thread");
        await sidebarHeader.waitFor({ state: "visible" });
        await expect.poll(() => create.isDisabled()).toBe(true);
        await capture(sidebarHeader, `after-disabled-${colorScheme}-crop.png`);
      } finally {
        await suite.closeBrowserContext(context);
      }
    });

    it(`contains a long agent name in ${colorScheme} mode`, async () => {
      const context = await suite.newBrowserContext({
        colorScheme,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      });
      const page = await context.newPage();
      await installMockGateway(page, { assistantName: "Roboclaw Research Workspace" });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        if (captureBaseline) {
          return;
        }
        const sidebarHeader = page.locator(".sidebar-brand");
        await sidebarHeader.waitFor({ state: "visible" });
        await expect
          .poll(() =>
            sidebarHeader.locator(".sidebar-agent-card").evaluate((element) => {
              const label = element.querySelector(".sidebar-agent-card__name");
              if (!label) {
                return false;
              }
              return label.scrollWidth > label.clientWidth;
            }),
          )
          .toBe(true);
        await capture(sidebarHeader, `after-overflow-${colorScheme}-crop.png`);
      } finally {
        await suite.closeBrowserContext(context);
      }
    });
  }
});
