import type { Page } from "playwright";
import { assert, expect, it } from "vitest";
import type {
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { buildSkillLibraryMock } from "../test-helpers/skill-library-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session skill library selections" });
const [alice, bob, team] = buildSkillLibraryMock();
const sessionKey = "agent:main:alice-session";
const bobSessionKey = "agent:main:bob-session";
const bobEntry = {
  ...bob.entry,
  canEdit: true,
  description: "Prepare the team's customer-facing release summary with complete review evidence.",
};
const teamEntry = {
  ...team.entry,
  description:
    "Turn a detailed support report into a reproducible investigation for the whole team.",
};
function projection(
  selected: SkillsLibraryReadResult[],
  key = sessionKey,
): SkillsLibraryListResult {
  return {
    entries: [bobEntry, teamEntry],
    profileId: "profile-bob",
    multipleProfiles: true,
    defaultTarget: "personal",
    canManageWorkspace: false,
    defaultSelectionLimit: 64,
    session: {
      sessionKey: key,
      selections: selected.map(({ entry }) => ({
        skillId: entry.skillId,
        revision: entry.revision,
        name: entry.name,
        ownerProfileId: entry.ownerProfileId,
        ownerLabel: entry.ownerLabel,
        slug: entry.slug,
        description: entry.description,
      })),
      attachable: [bobEntry, teamEntry].filter(
        (candidate) => !selected.some(({ entry }) => entry.skillId === candidate.skillId),
      ),
    },
  };
}
async function openSkills(page: Page) {
  const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
  const menu = pane.locator("wa-dropdown.agent-chat__capability-menu");
  if (!(await menu.evaluate((node) => (node as HTMLElement & { open: boolean }).open))) {
    await pane.getByRole("button", { name: "Add attachment", exact: true }).click();
  }
  if ((await menu.getAttribute("data-view"))?.startsWith("library:")) {
    await menu.getByRole("menuitem", { name: "Back", exact: true }).click();
  }
  const root = menu.getByRole("menuitem", { name: "Skills", exact: true });
  if (await root.isVisible()) {
    await root.click();
  }
  await menu.getByText("Selected for this session", { exact: true }).waitFor();
  return menu;
}

suite.define(() => {
  it.each([
    { access: "operator", canWrite: true },
    { access: "read-only", canWrite: false },
  ])("keeps Alice's private pin while Bob browses with $access access", async ({ canWrite }) => {
    await suite.withPage({ viewport: { width: 375, height: 844 } }, async ({ page }) => {
      const commands = [
        {
          name: alice.entry.name,
          skillDisplayName: `${alice.entry.slug} · Alice`,
          description: alice.entry.description,
          source: "skill",
          scope: "both",
          acceptsArgs: true,
          skillModelVisible: true,
          textAliases: [`/${alice.entry.name}`],
        },
      ];
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [
          { key: sessionKey, sessionId: "synthetic-alice-session" },
          { key: bobSessionKey, sessionId: "synthetic-bob-session" },
        ],
        operatorScopes: canWrite ? ["operator.read", "operator.write"] : ["operator.read"],
        methodResponses: {
          "chat.startup": {
            cases: [
              {
                match: { sessionKey },
                response: {
                  messages: [],
                  sessionId: "synthetic-alice-session",
                  thinkingLevel: null,
                  metadata: { commands, models: [] },
                },
              },
            ],
          },
          "skills.library.list": projection([alice]),
          "skills.library.read": { ...alice, entry: { ...alice.entry, canEdit: false } },
          "skills.library.activate": { sessionKey, selections: [], sessionActivation: "next-turn" },
          "chat.metadata": { commands, models: [] },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("chat.startup");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Use $release");
      const references = page.getByRole("listbox", { name: "Skill references" });
      await references.getByRole("option").filter({ hasText: "Alice" }).waitFor();
      await composer.press("Enter");
      await expect.poll(() => composer.inputValue()).toBe(`Use $${alice.entry.name} `);
      await composer.fill("");

      let menu = await openSkills(page);
      expect((await gateway.waitForRequest("skills.library.list")).params).toEqual({ sessionKey });
      const aliceItem = menu.locator(
        `wa-dropdown-item[value="library-selected:${alice.entry.skillId}"]`,
      );
      await aliceItem.waitFor();
      expect(await aliceItem.textContent()).toContain("release-notes · Alice");
      await menu
        .getByRole("menuitem", { name: "Attach release-notes · Bob", exact: false })
        .waitFor();
      const attachables = menu.locator('wa-dropdown-item[value^="library-attach:"]');
      const rows = await attachables.evaluateAll((items) =>
        items.map((item) => {
          const note = item.querySelector<HTMLElement>(".agent-chat__capability-menu-note")!;
          const label = item.querySelector<HTMLElement>(".agent-chat__capability-menu-label")!;
          return {
            row: item.getBoundingClientRect().toJSON(),
            label: label.getBoundingClientRect().toJSON(),
            note: note.getBoundingClientRect().toJSON(),
            lineHeight: Number.parseFloat(getComputedStyle(note).lineHeight),
          };
        }),
      );
      expect(rows).toHaveLength(2);
      assert(rows[0] && rows[1], "Both attachable skill rows must be measured.");
      for (const row of rows) {
        expect(row.label.bottom).toBeLessThanOrEqual(row.row.bottom + 1);
        expect(row.note.height).toBeLessThanOrEqual(row.lineHeight + 1);
      }
      expect(rows[0].label.bottom).toBeLessThanOrEqual(rows[1].label.top);
      expect(await attachables.first().textContent()).toContain(bobEntry.description);
      expect(
        await attachables
          .first()
          .locator(".agent-chat__capability-menu-note")
          .getAttribute("title"),
      ).toBe(bobEntry.description);
      const menuPanel = menu.locator('[part="menu"]');
      const listWidth = await menuPanel.evaluate((node) => node.getBoundingClientRect().width);
      // Native navigation keeps Web Awesome's active item aligned with browser focus.
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => aliceItem.evaluate((node) => node.matches(":focus"))).toBe(true);
      await page.keyboard.press("Enter");
      const readAction = menu.getByRole("menuitem", {
        name: "Read selected revision",
        exact: true,
      });
      await readAction.waitFor({ state: "visible" });
      const back = menu.getByRole("menuitem", { name: "Back", exact: true });
      await page.keyboard.press("Home");
      await expect.poll(() => back.evaluate((node) => node.matches(":focus"))).toBe(true);
      await page.keyboard.press("Enter");
      await menu.getByText("Selected for this session", { exact: true }).waitFor();
      expect(await gateway.getRequests("skills.library.activate")).toHaveLength(0);
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => aliceItem.evaluate((node) => node.matches(":focus"))).toBe(true);
      await page.keyboard.press("Enter");
      await readAction.waitFor({ state: "visible" });
      expect(await menu.getByText("release-notes · Alice", { exact: true }).count()).toBe(1);
      await menu.getByText("Selected revision 11111111", { exact: true }).waitFor();
      const actionBounds = await menuPanel.evaluate((node) =>
        node.getBoundingClientRect().toJSON(),
      );
      expect(actionBounds.width).toBeCloseTo(listWidth, 0);
      expect(actionBounds.left).toBeGreaterThanOrEqual(0);
      expect(actionBounds.right).toBeLessThanOrEqual(375);
      const actions = menu.locator('wa-dropdown-item[value^="library-"]');
      expect(await actions.allTextContents()).toEqual(
        canWrite
          ? ["Read selected revision", "Refresh revision", "Detach"]
          : ["Read selected revision"],
      );
      for (const action of await actions.all()) {
        expect(await action.isVisible()).toBe(true);
        expect(await action.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(
          true,
        );
        const bounds = await action.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
      }
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => readAction.evaluate((node) => node.matches(":focus"))).toBe(true);
      await page.keyboard.press("Enter");
      await page.getByLabel("SKILL.md", { exact: true }).waitFor();
      expect((await gateway.waitForRequest("skills.library.read")).params).toEqual({
        sessionKey,
        skillId: alice.entry.skillId,
        revision: alice.entry.revision,
      });
      expect(await page.getByLabel("SKILL.md", { exact: true }).inputValue()).toBe(alice.content);
      expect(await page.getByRole("button", { name: "Save skill", exact: true }).count()).toBe(0);
      expect(await page.getByLabel("Retained revision", { exact: true }).count()).toBe(0);
      const panel = page.locator(".md-preview-dialog__panel");
      expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      expect(await gateway.getRequests("skills.library.activate")).toHaveLength(0);
      await page.getByRole("button", { name: "Close", exact: true }).click();

      menu = await openSkills(page);
      await menu.getByRole("menuitem", { name: "Back", exact: true }).click();
      await menu.getByRole("menuitem", { name: /^Connectors/u }).click();
      await menu.getByRole("menuitem", { name: "Browse connectors", exact: true }).waitFor();
      expect(await menu.getByText("Selected for this session", { exact: true }).count()).toBe(0);
      expect(await menu.getByText("Add from your libraries", { exact: true }).count()).toBe(0);
      expect(await menu.locator('wa-dropdown-item[value^="library-"]').count()).toBe(0);
      if (!canWrite) {
        expect(await gateway.getRequests("skills.library.activate")).toHaveLength(0);
        expect(await gateway.getRequests("skills.library.save")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        return;
      }
      await menu.getByRole("menuitem", { name: "Back", exact: true }).click();
      menu = await openSkills(page);
      await gateway.setMethodResponse("skills.library.list", projection([]));
      await menu
        .locator(`wa-dropdown-item[value="library-selected:${alice.entry.skillId}"]`)
        .click();
      await menu.getByRole("menuitem", { name: "Detach", exact: true }).click();
      expect((await gateway.waitForRequest("skills.library.activate")).params).toEqual({
        action: "detach",
        sessionKey,
        skillId: alice.entry.skillId,
      });
      await menu.getByText("No managed skills selected.", { exact: true }).waitFor();
      await gateway.waitForRequest("chat.metadata");
      await menu.getByText(/updated for the next turn/u).waitFor();

      await gateway.setMethodResponse("skills.library.activate", {
        sessionKey,
        sessionActivation: "next-turn",
        selections: [
          {
            skillId: bob.entry.skillId,
            name: bob.entry.name,
            revision: bob.entry.revision,
            ownerProfileId: bob.entry.ownerProfileId,
          },
        ],
      });
      await gateway.setMethodResponse("skills.library.list", projection([bob]));
      await menu
        .getByRole("menuitem", { name: "Attach release-notes · Bob", exact: false })
        .click();
      await expect
        .poll(async () => (await gateway.getRequests("skills.library.activate")).length)
        .toBe(2);
      expect((await gateway.getRequests("skills.library.activate"))[1]?.params).toEqual({
        action: "attach",
        sessionKey,
        skillId: bob.entry.skillId,
        revision: bob.entry.revision,
      });
      const bobItem = menu.locator(
        `wa-dropdown-item[value="library-selected:${bob.entry.skillId}"]`,
      );
      await bobItem.waitFor();
      const newer = { ...bob, entry: { ...bob.entry, revision: "2".repeat(64) } };
      await gateway.setMethodResponse("skills.library.activate", {
        sessionKey,
        sessionActivation: "next-turn",
        selections: [
          {
            skillId: bob.entry.skillId,
            name: bob.entry.name,
            revision: newer.entry.revision,
            ownerProfileId: bob.entry.ownerProfileId,
          },
        ],
      });
      await gateway.setMethodResponse("skills.library.list", projection([newer]));
      await bobItem.click();
      await menu.getByRole("menuitem", { name: "Refresh revision", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests("skills.library.activate")).length)
        .toBe(3);
      expect((await gateway.getRequests("skills.library.activate"))[2]?.params).toEqual({
        action: "refresh",
        sessionKey,
        skillId: bob.entry.skillId,
      });
      await menu.getByText("Selected revision 22222222", { exact: true }).waitFor();
      await menu.getByText(/updated for the next turn/u).waitFor();

      await gateway.setMethodResponse("skills.library.list", projection([], bobSessionKey));
      await navigateToControlUiSession(page, bobSessionKey);
      menu = await openSkills(page);
      await menu.getByText("No managed skills selected.", { exact: true }).waitFor();
      expect((await gateway.getRequests("skills.library.list")).at(-1)?.params).toEqual({
        sessionKey: bobSessionKey,
      });
      expect(await gateway.getRequests("skills.library.activate")).toHaveLength(3);
      expect(await gateway.getRequests("skills.library.save")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
    });
  });
});
