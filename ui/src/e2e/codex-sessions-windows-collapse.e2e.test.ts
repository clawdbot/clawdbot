import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Codex Windows catalog collapse migration",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const catalogGroupingStorageKey = "openclaw:sidebar:sessions:catalog-grouping";
const collapsedSessionSectionsStorageKey = "openclaw:sidebar:sessions:collapsed-sections";

suite.define(() => {
  it("migrates catalog and regular Windows project keys through reload and expansion", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        deviceScaleFactor: 2,
        viewport: { height: 900, width: 1280 },
        ...(captureUiProofEnabled
          ? {
              recordVideo: {
                dir: path.join(suite.artifactDir, "windows-collapse-migration-video"),
                size: { height: 900, width: 1280 },
              },
            }
          : {}),
      },
      async ({ page }) => {
        const legacySectionId = String.raw`catalog-project:codex:gateway:local:project:C:\WORK\OPENCLAW\.CLAUDE\WORKTREES\fix-older`;
        const canonicalSectionId =
          "catalog-project:codex:gateway:local:project:windows:drive:c:/work/openclaw";
        const regularPath = String.raw`C:\Work\OpenClaw\.CLAUDE\WORKTREES\task`;
        const regularId = String.raw`project:C:\Work\OpenClaw`;
        await page.addInitScript(
          ({ groupingKey, legacyId, sectionsKey, regularPath: savedRegularPath }) => {
            localStorage.setItem(groupingKey, "project");
            localStorage.setItem("openclaw:sidebar:sessions:grouping", "project");
            if (localStorage.getItem(sectionsKey) === null) {
              localStorage.setItem(
                sectionsKey,
                JSON.stringify([legacyId, `project:${savedRegularPath}`]),
              );
            }
          },
          {
            groupingKey: catalogGroupingStorageKey,
            legacyId: legacySectionId,
            sectionsKey: collapsedSessionSectionsStorageKey,
            regularPath,
          },
        );
        await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
          methodResponses: {
            "sessions.list": {
              count: 1,
              defaults: { contextTokens: null, model: "fixture-model", modelProvider: "fixture" },
              path: "",
              ts: Date.now(),
              sessions: [
                {
                  key: "agent:main:windows-upgrade",
                  kind: "direct",
                  label: "Regular Windows workspace",
                  status: "idle",
                  updatedAt: Date.now(),
                  spawnedWorkspaceDir: regularPath,
                },
              ],
            },
            "sessions.catalog.list": {
              catalogs: [
                {
                  id: "codex",
                  label: "Codex",
                  capabilities: { continueSession: true, archive: true },
                  hosts: [
                    {
                      hostId: "gateway:local",
                      label: "Local Codex",
                      kind: "gateway",
                      connected: true,
                      sessions: [
                        {
                          threadId: "thread-direct",
                          name: "Direct Windows checkout",
                          cwd: "C:\\Work\\OpenClaw",
                          status: "idle",
                          archived: false,
                          canContinue: true,
                          canArchive: true,
                        },
                        {
                          threadId: "thread-worktree",
                          name: "Windows worktree checkout",
                          cwd: "c:/work/openclaw/.CLAUDE/WORKTREES/fix-new/ui/src",
                          status: "idle",
                          archived: false,
                          canContinue: true,
                          canArchive: true,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        const regularSection = page.locator(`[data-session-section=${JSON.stringify(regularId)}]`);
        const regularToggle = regularSection.locator(".sidebar-session-group-toggle");
        await expect.poll(() => regularToggle.getAttribute("aria-expanded")).toBe("false");
        const section = page.locator('[data-session-section="catalog:codex"]');
        const project = section.locator(
          '[data-session-catalog-project="project:windows:drive:c:/work/openclaw"]',
        );
        await project.waitFor({ state: "visible" });
        await expect.poll(() => project.getAttribute("aria-expanded")).toBe("false");
        expect(await section.locator("[data-session-catalog-project]").count()).toBe(1);
        expect(await section.getByText("Direct Windows checkout", { exact: true }).count()).toBe(0);
        expect(
          await page.evaluate(
            (key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
            collapsedSessionSectionsStorageKey,
          ),
        ).toEqual([regularId, canonicalSectionId]);
        if (captureUiProofEnabled) {
          await section.screenshot({
            animations: "disabled",
            path: path.join(suite.artifactDir, "01-windows-project-collapsed-after-migration.png"),
          });
        }

        await page.reload();
        await expect.poll(() => regularToggle.getAttribute("aria-expanded")).toBe("false");
        await project.waitFor({ state: "visible" });
        await expect.poll(() => project.getAttribute("aria-expanded")).toBe("false");
        expect(
          await page.evaluate(
            (key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
            collapsedSessionSectionsStorageKey,
          ),
        ).toEqual([regularId, canonicalSectionId]);
        if (captureUiProofEnabled) {
          await section.screenshot({
            animations: "disabled",
            path: path.join(
              suite.artifactDir,
              "02-windows-project-still-collapsed-after-reload.png",
            ),
          });
        }

        await project.click();
        await regularToggle.click();
        await regularSection.getByText("Regular Windows workspace", { exact: true }).waitFor();
        await expect.poll(() => project.getAttribute("aria-expanded")).toBe("true");
        expect(await section.getByText("Direct Windows checkout", { exact: true }).count()).toBe(1);
        expect(await section.getByText("Windows worktree checkout", { exact: true }).count()).toBe(
          1,
        );
        if (captureUiProofEnabled) {
          await section.screenshot({
            animations: "disabled",
            path: path.join(suite.artifactDir, "03-windows-project-expanded.png"),
          });
        }
        await page.reload();
        await expect.poll(() => regularToggle.getAttribute("aria-expanded")).toBe("true");
        await expect.poll(() => project.getAttribute("aria-expanded")).toBe("true");
        expect(
          await page.evaluate(
            (key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
            collapsedSessionSectionsStorageKey,
          ),
        ).toEqual([]);
      },
    );
  });
});
