import path from "node:path";
import { expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI Home context updates" });

suite.define(() => {
  it.each(["workspace", "dashboard"] as const)(
    "keeps the Home conversation usable with a saved %s main panel",
    async (mainSlot) => {
      const artifactDir = suite.artifactDir;
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, recordVideo: { dir: artifactDir } },
        async ({ page }) => {
          const workKey = "agent:main:parser";
          const homeKey = "agent:main:main";
          const savedLayout = {
            columns: [
              {
                id: "side-panel-column",
                side: "right",
                panels: [
                  { id: mainSlot, slot: mainSlot },
                  { id: "conversation", slot: "conversation" },
                ],
                activePanelId: "conversation",
                width: 480,
                height: 360,
              },
            ],
            mainPanelId: mainSlot,
            open: true,
          };
          const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
          await page.addInitScript(
            ({ key, homeKey: homeSessionKey, workKey: workSessionKey, layout }) => {
              localStorage.setItem(
                key,
                JSON.stringify({
                  sessionKey: workSessionKey,
                  sidebarSessionLayouts: { [homeSessionKey]: layout },
                }),
              );
            },
            { key: settingsKey, homeKey, workKey, layout: savedLayout },
          );
          const gateway = await installMockGateway(page, {
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "board.get",
              "chat.history",
              "chat.send",
            ],
            sessionKey: workKey,
            sessions: [workKey, homeKey].map((key) => ({
              key,
              kind: "direct",
              updatedAt: Date.now(),
              label: key === homeKey ? "Personal Home" : "Parser work",
            })),
            historyMessages: [{ role: "assistant", content: "Home is ready to help." }],
            methodResponses: {
              "board.get": {
                sessionKey: homeKey,
                revision: 1,
                tabs: [{ tabId: "main", title: "Main", position: 0 }],
                widgets: [],
              },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, workKey));
          await gateway.waitForRequest("chat.startup");
          await page.locator(".sidebar-footer-bar__home").click();
          const panel = page.locator("openclaw-assistant-panel");
          await panel.locator("openclaw-chat-pane").waitFor();
          await gateway.waitForRequest("chat.startup", { after: 1 });
          await page.screenshot({ path: path.join(artifactDir, "home-open.png") });
          const composer = panel.locator(".agent-chat__composer-combobox textarea");
          await expect.poll(() => composer.isVisible()).toBe(true);
          await composer.fill("Help with the current work");
          await composer.press("Enter");
          expect((await gateway.waitForRequest("chat.send")).params).toMatchObject({
            sessionKey: homeKey,
          });
          expect(
            await page.evaluate(
              ({ key, homeKey: homeSessionKey }) =>
                JSON.parse(localStorage.getItem(key) ?? "{}").sidebarSessionLayouts[homeSessionKey]
                  .mainPanelId,
              { key: settingsKey, homeKey },
            ),
          ).toBe(mainSlot);
          await page.screenshot({ path: path.join(artifactDir, "home-message-sent.png") });
        },
      );
    },
  );

  it("refreshes open Home context after a roster-only title update", async () => {
    const proofDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim()
      ? suite.artifactDir
      : undefined;
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        ...(proofDir ? { recordVideo: { dir: proofDir } } : {}),
      },
      async ({ page }) => {
        const work = {
          key: "agent:main:parser",
          agentId: "main",
          kind: "direct",
          updatedAt: Date.now(),
          label: "Parser work",
          sessionId: "parser-incarnation",
          spawnedWorkspaceDir: "/worktrees/parser",
        } satisfies GatewaySessionRow;
        const home = {
          key: "agent:main:main",
          agentId: "main",
          kind: "direct",
          updatedAt: work.updatedAt,
          label: "Personal Home",
        } satisfies GatewaySessionRow;
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "chat.history", "chat.send"],
          sessionKey: work.key,
          sessions: [work, home],
          historyMessages: [
            { role: "assistant", content: [{ type: "text", text: "Parser workspace ready." }] },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, work.key));
        await page.locator(".sidebar-footer-bar__home").click();
        const panel = page.locator("openclaw-assistant-panel");
        const details = panel.locator(".assistant-panel-context details");
        await details.locator("summary").click();
        const reference = details.locator("pre");
        await expect.poll(() => reference.textContent()).toContain('"title":"Parser work"');
        if (proofDir) {
          await page.screenshot({ path: path.join(proofDir, "01-initial-context.png") });
        }

        const renamed = { ...work, label: "Renamed workspace", updatedAt: Date.now() + 1 };
        const list: SessionsListResult = {
          ts: Date.now(),
          path: "",
          count: 2,
          defaults: { modelProvider: "openai", model: "gpt-5.6-luna", contextTokens: null },
          sessions: [renamed, home],
        };
        await gateway.setSessionsListResponse(list);
        await gateway.emitGatewayEvent("sessions.changed", {
          ...renamed,
          sessionKey: work.key,
          reason: "patch",
        });
        const row = page.locator(`.sidebar-recent-session[data-session-key="${work.key}"]`);
        // Confirm the roster and shell observed the update without changing the route or pane.
        await expect.poll(() => row.textContent()).toContain(renamed.label);
        await expect.poll(() => reference.textContent()).toContain('"title":"Renamed workspace"');
        if (proofDir) {
          await page.screenshot({ path: path.join(proofDir, "02-renamed-context.png") });
        }

        const composer = panel.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Review the current work");
        await composer.press("Enter");
        const sent = await gateway.waitForRequest("chat.send");
        expect(sent.params).toMatchObject({
          message: expect.stringContaining('"title":"Renamed workspace"'),
        });
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      },
    );
  });
});
