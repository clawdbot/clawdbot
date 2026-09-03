import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite, tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sidebar section column alignment" });

suite.define(() => {
  it.each([false, true])(
    "keeps counts beside labels and aligns actions (touch: %s)",
    async (hasTouch) => {
      await suite.withPage(
        {
          hasTouch,
          colorScheme: "dark",
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: 1440, height: 1000 },
        },
        async ({ page }) => {
          const timestamp = Date.parse("2026-08-27T12:00:00.000Z");
          const sections = [
            { id: "category:Personal", count: 1 },
            { id: "category:Automations", count: 1 },
            { id: "ungrouped", count: 1 },
            { id: "work", count: 1 },
            { id: "catalog:claude", count: 51 },
            { id: "catalog:codex", count: 11 },
          ];
          const gateway = await installMockGateway(page, {
            sessionKey: "agent:main:main",
            sessionGroups: ["Personal", "Automations"],
            featureMethods: [...defaultControlUiFeatureMethods, "sessions.catalog.list"],
            methodResponses: {
              "sessions.list": sessionsListResponse([
                sessionRow("agent:main:main", "Home", timestamp),
                sessionRow("agent:main:personal", "Personal thread", timestamp, {
                  category: "Personal",
                }),
                sessionRow("agent:main:automation", "Scheduled review", timestamp, {
                  category: "Automations",
                }),
                sessionRow("agent:main:other", "Ungrouped thread", timestamp),
                sessionRow("agent:main:work", "Coding thread", timestamp, {
                  worktree: { branch: "feature/sidebar", repoRoot: "/workspace/project" },
                }),
              ]),
              "sessions.catalog.list": {
                catalogs: [
                  { id: "claude", label: "Claude Code", count: 51, creatable: false },
                  { id: "codex", label: "Codex", count: 11, creatable: true },
                ].map(({ id, label, count, creatable }) => ({
                  id,
                  label,
                  capabilities: {
                    continueSession: false,
                    archive: false,
                    // Model-chat creation does not enable the native-terminal action.
                    ...(creatable
                      ? { startTerminal: true }
                      : { createSession: { model: "openai/gpt-5.6-luna" } }),
                  },
                  hosts: [
                    {
                      hostId: "gateway:local",
                      label: `Local ${label}`,
                      kind: "gateway",
                      connected: true,
                      canStartTerminal: creatable,
                      sessions: Array.from({ length: count }, (_, index) => ({
                        threadId: `${id}-${index}`,
                        name: `${label} thread ${index}`,
                        status: "stored",
                        canContinue: false,
                        canArchive: false,
                      })),
                    },
                  ],
                })),
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          for (const { id } of sections) {
            const toggle = page.locator(
              `[data-session-section="${id}"] .sidebar-session-group-toggle`,
            );
            await toggle.waitFor({ state: "visible" });
            if ((await toggle.getAttribute("aria-expanded")) === "true") {
              await toggle.click();
            }
            await page
              .locator(
                `[data-session-section="${id}"] .sidebar-session-group-toggle[aria-expanded="false"]`,
              )
              .waitFor({ state: "visible" });
          }
          const codex = page.locator('[data-session-section="catalog:codex"]');
          await codex.locator(".sidebar-recent-sessions__head").hover();
          await captureSidebarUiProof(
            suite,
            page,
            `sidebar-alignment-${hasTouch ? "touch" : "mouse"}.png`,
          );
          const geometry = await page.evaluate(
            (expectedSections) =>
              expectedSections.map(({ id }) => {
                const header = document.querySelector(
                  `[data-session-section="${id}"] .sidebar-recent-sessions__head`,
                );
                const measure = (selector: string, textOnly = false) => {
                  const element = header?.querySelector(selector);
                  if (!element) {
                    return null;
                  }
                  const range = document.createRange();
                  range.selectNodeContents(element);
                  // The label box can flex wider than its text and hide the actual gap.
                  const rect = textOnly
                    ? range.getBoundingClientRect()
                    : element.getBoundingClientRect();
                  return { left: rect.left, right: rect.right, center: rect.left + rect.width / 2 };
                };
                return {
                  id,
                  countText: header
                    ?.querySelector(".sidebar-session-group-count")
                    ?.textContent?.trim(),
                  label: measure(".sidebar-recent-sessions__label-text", true),
                  count: measure(".sidebar-session-group-count"),
                  menu: measure('.sidebar-session-group-actions[aria-haspopup="menu"]'),
                  add: measure(".sidebar-new-session, .sidebar-session-catalog-new"),
                };
              }),
            sections,
          );
          expect(geometry.map((header) => header.countText)).toEqual(
            sections.map(({ count }) => String(count)),
          );
          for (const header of geometry) {
            const countGap =
              (header.count?.left ?? Number.NaN) - (header.label?.right ?? Number.NaN);
            expect(countGap, header.id).toBeGreaterThanOrEqual(4);
            expect(countGap, header.id).toBeLessThanOrEqual(12);
          }
          for (const control of ["menu", "add"] as const) {
            const centers = geometry.flatMap((header) => {
              const position = header[control];
              return position ? [position.center] : [];
            });
            expect(centers).toHaveLength(4);
            expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
          }
          const codexAdd = codex.locator(".sidebar-session-catalog-new");
          expect(await codexAdd.getAttribute("href")).toBe("/new?agent=main&catalog=codex");
          expect(await codexAdd.getAttribute("aria-disabled")).toBeNull();
          const claude = page.locator('[data-session-section="catalog:claude"]');
          const claudeAdd = claude.locator(".sidebar-session-catalog-new");
          expect(await claudeAdd.getAttribute("aria-disabled")).toBe("true");
          expect(await claudeAdd.getAttribute("href")).toBeNull();
          if (hasTouch) {
            const bounds = await claudeAdd.boundingBox();
            if (!bounds) {
              throw new Error("The unavailable add control must remain visible on touch");
            }
            await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
          } else {
            await claude.locator(".sidebar-recent-sessions__head").hover();
            await claudeAdd.hover();
          }
          await claude
            .locator("openclaw-tooltip[open] .tooltip-content")
            .waitFor({ state: "visible" });
          await expect
            .poll(() => tooltipTitleText(claudeAdd))
            .toBe(
              "Starting new sessions is not supported by Claude Code. Choose another session source.",
            );
          await captureSidebarUiProof(
            suite,
            page,
            `sidebar-disabled-${hasTouch ? "touch" : "mouse"}.png`,
          );
          if (!hasTouch) {
            await page.mouse.move(800, 700);
            await claude.locator("[data-session-catalog-view-menu]").focus();
            await page.keyboard.press("Tab");
            expect(await claudeAdd.evaluate((element) => element === document.activeElement)).toBe(
              true,
            );
            await claude
              .locator("openclaw-tooltip[open] .tooltip-content")
              .waitFor({ state: "visible" });
            await page.keyboard.press("Enter");
          }
          const originalUrl = page.url();
          await claudeAdd.dispatchEvent("click");
          expect(page.url()).toBe(originalUrl);
          expect(await gateway.getRequests("sessions.create")).toEqual([]);
          expect(await gateway.getRequests("sessions.catalog.startTerminal")).toEqual([]);
        },
      );
    },
  );
});
