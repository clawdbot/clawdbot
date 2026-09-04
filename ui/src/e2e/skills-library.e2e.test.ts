import type { Page } from "playwright";
import { expect, it } from "vitest";
import type {
  SkillsLibraryListResult,
  SkillsLibraryReceipt,
} from "../../../packages/gateway-protocol/src/index.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { buildSkillLibraryMock } from "../test-helpers/skill-library-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Custom skill libraries" });
const own = buildSkillLibraryMock()[0];
const shared = buildSkillLibraryMock()[1];
const team = buildSkillLibraryMock()[2];
const list: SkillsLibraryListResult = {
  entries: [own.entry, shared.entry, team.entry],
  profileId: "profile-alice",
  multipleProfiles: true,
  defaultTarget: "personal",
  canManageWorkspace: false,
  defaultSelectionLimit: 64,
};
const published: SkillsLibraryReceipt = {
  state: "published",
  target: "personal",
  entry: { ...own.entry, revision: "2".repeat(64) },
  sessionActivation: "new-sessions",
  nextAction: "Refresh explicitly in existing sessions.",
};
const status = {
  workspaceDir: "/tmp/synthetic-workspace",
  managedSkillsDir: "/tmp/synthetic-skills",
  skills: [],
};

async function expectLibraryDialogOpen(page: Page) {
  const dialog = page.locator("openclaw-modal-dialog dialog");
  await dialog.evaluate(async (element) => {
    await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
  expect(await dialog.isVisible()).toBe(true);
}

suite.define(() => {
  it("keeps workspace creation for a solo shared-token admin with many channel identities", async () => {
    await suite.withPage({}, async ({ page }) => {
      const proposal = {
        record: { id: "proposal-synthetic", status: "pending" },
        content: "Draft",
        revisionHash: "a".repeat(64),
      };
      const gateway = await installMockGateway(page, {
        presenceUsers: [
          { id: "channel-1", name: "Sender one" },
          { id: "channel-2", name: "Sender two" },
          { id: "channel-3", name: "Sender three" },
        ],
        methodResponses: {
          "skills.library.list": {
            entries: [],
            profileId: null,
            multipleProfiles: false,
            defaultTarget: "workspace",
            canManageWorkspace: true,
            defaultSelectionLimit: 64,
          },
          "skills.status": status,
          "skills.proposals.create": proposal,
          "skills.proposals.apply": {
            record: { ...proposal.record, status: "applied" },
            targetSkillFile: "/tmp/synthetic-workspace/skills/checklist/SKILL.md",
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}skills`);
      await page.getByRole("button", { name: "Create skill", exact: true }).click();
      expect(await page.getByText("My skills", { exact: true }).count()).toBe(0);
      expect(await page.getByText("Team", { exact: true }).count()).toBe(0);
      await page.getByLabel("Skill name", { exact: true }).fill("checklist");
      await page.getByLabel("Description", { exact: true }).fill("A repeatable checklist");
      await page
        .getByLabel("SKILL.md", { exact: true })
        .fill("---\nname: checklist\ndescription: A repeatable checklist\n---\nDo the work.\n");
      await page.getByRole("button", { name: "Save workspace proposal" }).click();
      const request = await gateway.waitForRequest("skills.proposals.create");
      expect(request.params).toMatchObject({ agentId: "main", name: "checklist" });
      await page.getByText(/pending review and is not active yet/u).waitFor();
      expect(await gateway.getRequests("skills.proposals.apply")).toHaveLength(0);
      await page.getByRole("button", { name: "Apply to workspace" }).click();
      expect((await gateway.waitForRequest("skills.proposals.apply")).params).toEqual({
        agentId: "main",
        proposalId: "proposal-synthetic",
        expectedRevisionHash: "a".repeat(64),
      });
      await page.getByText(/Workspace main: applied/u).waitFor();
      expect(await gateway.getRequests("skills.library.save")).toHaveLength(0);
    });
  });

  it("saves and edits an operator's complete bundle, preserving a stale draft on a narrow viewport", async () => {
    await suite.withPage({ viewport: { width: 375, height: 844 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        methodResponses: {
          "skills.library.list": list,
          "skills.status": status,
          "skills.library.read": own,
          "skills.library.save": published,
        },
      });
      await page.goto(`${suite.server.baseUrl}skills`);
      await page.getByRole("button", { name: "Create skill", exact: true }).click();
      await page.getByLabel("Skill name", { exact: true }).fill("release-notes");
      await page.getByLabel("SKILL.md", { exact: true }).fill(own.content);
      await page.getByLabel("SKILL.md", { exact: true }).press("Control+Enter");
      expect((await gateway.waitForRequest("skills.library.save")).params).toEqual({
        slug: "release-notes",
        content: own.content,
        files: [],
        expectedRevision: null,
      });
      await page.getByText(/Saved release-notes to personal library/u).waitFor();
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: /release-notes Draft concise/u }).click();
      expect((await gateway.waitForRequest("skills.library.read")).params).toEqual({
        skillId: own.entry.skillId,
      });
      await expect
        .poll(() => page.getByLabel("SKILL.md", { exact: true }).inputValue())
        .toBe(own.content);
      const currentRevision = "b".repeat(64);
      const externalContent = `${own.content}\nSaved by another editor.\n`;
      await gateway.setMethodResponse("skills.library.read", {
        ...own,
        entry: { ...own.entry, revision: currentRevision },
        content: externalContent,
      });
      await page.getByLabel("File", { exact: true }).selectOption("references/checklist.md");
      expect(
        await page.getByLabel("references/checklist.md", { exact: true }).inputValue(),
      ).toContain("Confirm the behavior");
      await page.getByLabel("File", { exact: true }).selectOption("assets/sample.bin");
      await page.getByText(/original bytes are preserved/u).waitFor();
      await page.getByLabel("Executable supporting file").check();
      await page.getByLabel("File", { exact: true }).selectOption("SKILL.md");
      const draft = `${own.content}\nKeep this draft.\n`;
      await page.getByLabel("SKILL.md", { exact: true }).fill(draft);
      page.once("dialog", (dialog) => {
        expect(dialog.message()).toBe("Discard your unsaved skill changes?");
        void dialog.dismiss();
      });
      await page.keyboard.press("Escape");
      await expectLibraryDialogOpen(page);
      expect(await page.getByLabel("SKILL.md", { exact: true }).inputValue()).toBe(draft);
      await gateway.deferNext("skills.library.save");
      await page.getByRole("button", { name: "Save skill", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests("skills.library.save")).length)
        .toBe(2);
      const saves = await gateway.getRequests("skills.library.save");
      expect(await page.getByRole("button", { name: "Close", exact: true }).isDisabled()).toBe(
        true,
      );
      await page.keyboard.press("Escape");
      await expectLibraryDialogOpen(page);
      expect(saves[1]?.params).toEqual({
        skillId: own.entry.skillId,
        slug: own.entry.slug,
        expectedRevision: own.entry.revision,
        content: draft,
        files: own.files.map((file) =>
          file.path === "assets/sample.bin" ? { ...file, executable: true } : file,
        ),
      });
      await gateway.rejectDeferred("skills.library.save", {
        code: "INVALID_REQUEST",
        message: "Concurrent update",
        details: { code: "SKILL_LIBRARY_CONFLICT", currentRevision },
      });
      await page.getByRole("alert").filter({ hasText: "Your draft is preserved" }).waitFor();
      expect(await page.getByLabel("SKILL.md", { exact: true }).inputValue()).toBe(draft);
      const form = page.locator("form.md-preview-dialog__panel");
      expect(await form.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
        true,
      );
      page.once("dialog", (dialog) => {
        expect(dialog.message()).toBe("Discard your unsaved skill changes?");
        void dialog.accept();
      });
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "Import skill", exact: true }).click();
      const importer = page.locator("openclaw-modal-dialog");
      await importer.getByLabel("Skill name", { exact: true }).waitFor();
      expect(await importer.getByLabel("Skill name", { exact: true }).inputValue()).toBe("");
      expect(await importer.getByRole("alert").allTextContents()).toEqual([]);
      expect(await importer.getByRole("status").allTextContents()).toEqual([]);
      expect(
        await importer
          .locator(".md-preview-dialog__body")
          .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      await importer.getByLabel("Skill name", { exact: true }).fill("abandoned-import");
      await importer.locator('input[name="library-import-files"]').setInputFiles({
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Missing SKILL.md"),
      });
      await importer.getByRole("button", { name: "Import skill", exact: true }).click();
      await importer.getByRole("alert").waitFor();
      await importer.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "Import skill", exact: true }).click();
      await importer.getByLabel("Skill name", { exact: true }).waitFor();
      expect(await importer.getByLabel("Skill name", { exact: true }).inputValue()).toBe("");
      expect(await importer.getByRole("alert").count()).toBe(0);
      expect(
        await importer.getByRole("button", { name: "Import skill", exact: true }).isDisabled(),
      ).toBe(true);
      await importer.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "Create skill", exact: true }).click();
      expect(await page.getByLabel("SKILL.md", { exact: true }).inputValue()).toBe("");
      expect(await page.locator("openclaw-modal-dialog").getByRole("alert").count()).toBe(0);
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: /release-notes Draft concise/u }).click();
      await expect
        .poll(() => page.getByLabel("SKILL.md", { exact: true }).inputValue())
        .toBe(externalContent);
      for (const method of [
        "skills.install",
        "skills.update",
        "config.patch",
        "skills.library.activate",
      ]) {
        expect(await gateway.getRequests(method)).toHaveLength(0);
      }
    });
  });

  it.each([1280, 375])(
    "keeps the file picker aligned through add, select, delete and keyboard save at %ipx",
    async (width) => {
      await suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.read", "operator.write"],
          methodResponses: {
            "skills.library.list": list,
            "skills.status": status,
            "skills.library.save": published,
          },
        });
        await page.goto(`${suite.server.baseUrl}skills`);
        await page.getByRole("button", { name: "Create skill", exact: true }).click();
        await page.getByLabel("Skill name", { exact: true }).fill("release-notes");
        const skill = page.getByLabel("SKILL.md", { exact: true });
        await skill.fill(own.content);
        await page.getByLabel("New text file path", { exact: true }).fill("references/lilac.txt");
        await page.getByRole("button", { name: "Add file", exact: true }).press("Enter");
        const support = page.getByLabel("references/lilac.txt", { exact: true });
        await support.fill("Supporting instructions.\n");
        const picker = page.getByLabel("File", { exact: true });
        expect(await picker.inputValue()).toBe("references/lilac.txt");
        expect(await support.inputValue()).toBe("Supporting instructions.\n");
        await support.press("Control+Enter");
        expect((await gateway.waitForRequest("skills.library.save")).params).toEqual({
          slug: "release-notes",
          content: own.content,
          files: [
            {
              path: "references/lilac.txt",
              content: "Supporting instructions.\n",
              encoding: "utf8",
            },
          ],
          expectedRevision: null,
        });
        await page.getByText(/Saved release-notes to personal library/u).waitFor();
        expect(await picker.inputValue()).toBe("references/lilac.txt");
        expect(await support.inputValue()).toBe("Supporting instructions.\n");
        await picker.selectOption("SKILL.md");
        expect(await skill.inputValue()).toBe(own.content);
        await picker.selectOption("references/lilac.txt");
        expect(await support.inputValue()).toBe("Supporting instructions.\n");
        page.once("dialog", (dialog) => void dialog.accept());
        await page.getByRole("button", { name: "Delete file", exact: true }).press("Enter");
        expect(await picker.inputValue()).toBe("SKILL.md");
        expect(await skill.inputValue()).toBe(own.content);
        expect(await picker.locator('option[value="references/lilac.txt"]').count()).toBe(0);
        await skill.press("Control+Enter");
        await expect
          .poll(async () => (await gateway.getRequests("skills.library.save")).length)
          .toBe(2);
        expect((await gateway.getRequests("skills.library.save"))[1]?.params).toEqual({
          skillId: published.entry.skillId,
          expectedRevision: published.entry.revision,
          slug: "release-notes",
          content: own.content,
          files: [],
        });
      });
    },
  );

  it("imports local support files privately and keeps shared entries read-only", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        methodResponses: {
          "skills.library.list": list,
          "skills.status": status,
          "skills.library.read": {
            cases: [
              { match: { skillId: shared.entry.skillId }, response: shared },
              { match: { skillId: team.entry.skillId }, response: team },
            ],
          },
          "skills.library.save": published,
        },
      });
      await page.goto(`${suite.server.baseUrl}skills`);
      await page.getByRole("button", { name: "Import skill", exact: true }).click();
      await page.getByLabel("Skill name", { exact: true }).fill("checklist");
      await page.locator('input[name="library-import-files"]').setInputFiles([
        { name: "SKILL.md", mimeType: "text/markdown", buffer: Buffer.from(own.content) },
        { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("untouched\r\n") },
      ]);
      await page
        .locator("openclaw-modal-dialog")
        .getByRole("button", { name: "Import skill", exact: true })
        .click();
      await page.getByRole("button", { name: "Save skill", exact: true }).click();
      expect((await gateway.waitForRequest("skills.library.save")).params).toMatchObject({
        expectedRevision: null,
        slug: "checklist",
        files: [
          {
            path: "notes.txt",
            content: Buffer.from("untouched\r\n").toString("base64"),
            encoding: "base64",
          },
        ],
      });
      await page.getByText(/Saved release-notes to personal library/u).waitFor();
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("radio", { name: "Team", exact: true }).click();
      await page.getByRole("button", { name: /release-notes Prepare the team's/u }).click();
      await page.getByText(/Only its owner or an authorized administrator/u).waitFor();
      expect(await page.getByRole("button", { name: "Transfer to team" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Share with team" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Save skill", exact: true }).count()).toBe(0);
      expect(await page.getByLabel("Executable supporting file").count()).toBe(0);
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: /support-triage Turn a support report/u }).click();
      await page
        .getByText(`Team · revision ${team.entry.revision.slice(0, 8)}`, { exact: true })
        .waitFor();
      expect(await page.getByText(team.entry.skillId, { exact: true }).isVisible()).toBe(false);
      await page.getByText("Skill details", { exact: true }).click();
      await page.getByText(team.entry.skillId, { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Save skill", exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("skills.install")).toHaveLength(0);
      expect(await gateway.getRequests("skills.update")).toHaveLength(0);
    });
  });

  it("uploads chosen ZIP bytes privately and reports the committed library", async () => {
    await suite.withPage({}, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const bytes = Buffer.from([80, 75, 3, 4, 0, 255, 13, 10]);
      const uploadId = "44444444-4444-4444-8444-444444444444";
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        methodResponses: {
          "skills.library.list": list,
          "skills.library.upload": {
            cases: [
              {
                match: { action: "begin" },
                response: { uploadId, offset: 0, maxChunkBytes: 256000 },
              },
              {
                match: { action: "chunk" },
                response: { uploadId, offset: bytes.length, maxChunkBytes: 256000 },
              },
              { match: { action: "commit" }, response: published },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}skills`);
      await page.getByRole("button", { name: "Import skill", exact: true }).click();
      await page.getByLabel("Skill name", { exact: true }).fill("release-notes");
      await page
        .locator('input[name="library-import-files"]')
        .setInputFiles({ name: "release-notes.zip", mimeType: "application/zip", buffer: bytes });
      expect(await gateway.getRequests("skills.library.upload")).toHaveLength(0);
      await gateway.deferNext("skills.library.upload");
      await page
        .locator("openclaw-modal-dialog")
        .getByRole("button", { name: "Import skill", exact: true })
        .click();
      await gateway.waitForRequest("skills.library.upload");
      await page.keyboard.press("Escape");
      await expectLibraryDialogOpen(page);
      await gateway.resolveDeferred("skills.library.upload", {
        uploadId,
        offset: 0,
        maxChunkBytes: 256000,
      });
      await page.getByText(/Saved release-notes to personal library/u).waitFor();
      const requests = await gateway.getRequests("skills.library.upload");
      expect(requests.map((request) => request.params)).toEqual([
        {
          action: "begin",
          slug: "release-notes",
          sizeBytes: bytes.length,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        { action: "chunk", uploadId, offset: 0, data: bytes.toString("base64") },
        { action: "commit", uploadId },
      ]);
      expect(await gateway.getRequests("skills.install")).toHaveLength(0);
      expect(await gateway.getRequests("skills.library.save")).toHaveLength(0);
      expect(pageErrors).toEqual([]);
    });
  });

  it("uses stable identity for share, transfer, rollback, and removal receipts", async () => {
    await suite.withPage({}, async ({ page }) => {
      page.on("dialog", (dialog) => void dialog.accept());
      const oldRevision = "0".repeat(64);
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "skills.library.list": { ...list, canManageWorkspace: true },
          "skills.status": status,
          "skills.library.read": {
            ...own,
            revisions: [...own.revisions, { revision: oldRevision, createdAt: 1 }],
          },
          "skills.library.mutate": published,
        },
      });
      await page.goto(`${suite.server.baseUrl}skills`);
      await page.getByRole("button", { name: /release-notes Draft concise/u }).click();
      await page.getByRole("button", { name: "Share with team", exact: true }).click();
      expect((await gateway.waitForRequest("skills.library.mutate")).params).toMatchObject({
        skillId: own.entry.skillId,
        expectedRevision: own.entry.revision,
        action: "share",
      });
      await page.getByText(/Saved release-notes to personal library/u).waitFor();
      const restored = { ...published.entry, revision: oldRevision };
      await gateway.setMethodResponse("skills.library.mutate", { ...published, entry: restored });
      await gateway.setMethodResponse("skills.library.read", {
        ...own,
        entry: restored,
        content: `${own.content}Restored instructions.\n`,
      });
      await page.getByLabel("Retained revision").selectOption(oldRevision);
      await page.getByRole("button", { name: "Restore revision" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("skills.library.mutate")).length)
        .toBe(2);
      expect((await gateway.getRequests("skills.library.mutate"))[1]?.params).toMatchObject({
        skillId: own.entry.skillId,
        action: "rollback",
        revision: oldRevision,
      });
      await expect
        .poll(() => page.getByLabel("SKILL.md", { exact: true }).inputValue())
        .toContain("Restored instructions.");
      expect((await gateway.getRequests("skills.library.read"))[1]?.params).toEqual({
        skillId: own.entry.skillId,
        revision: oldRevision,
      });
      await gateway.setMethodResponse("skills.library.mutate", {
        ...published,
        target: "team",
        entry: { ...published.entry, ownerProfileId: null, ownerLabel: "Team", shared: true },
      });
      await page.getByRole("button", { name: "Transfer to team", exact: true }).click();
      await page.getByText(/Saved release-notes to team library/u).waitFor();
      await page
        .getByText(`Team · revision ${published.entry.revision.slice(0, 8)}`, { exact: true })
        .waitFor();
      const disabledNotice =
        "Disabled for new-session defaults. Existing sessions retain their selected revision; explicit attachment remains available.";
      await gateway.setMethodResponse("skills.library.mutate", {
        ...published,
        target: "team",
        entry: {
          ...published.entry,
          ownerProfileId: null,
          ownerLabel: "Team",
          shared: true,
          enabled: false,
        },
        nextAction: disabledNotice,
      });
      await page.getByRole("button", { name: "Disable", exact: true }).click();
      await page.getByText(disabledNotice, { exact: false }).waitFor();
      expect(await page.getByText(/Available in new sessions/u).count()).toBe(0);
      await page.getByRole("button", { name: "Enable", exact: true }).waitFor();
      await gateway.setMethodResponse("skills.library.mutate", {
        ...published,
        state: "removed",
        target: "team",
        entry: { ...published.entry, removed: true, ownerProfileId: null, ownerLabel: "Team" },
        nextAction:
          "Existing sessions retain their pinned revision. Create a new skill to add it to future sessions.",
      });
      await page.getByRole("button", { name: "Remove skill", exact: true }).click();
      await page.getByText(/Removed release-notes from team library/u).waitFor();
      expect(
        (await gateway.getRequests("skills.library.mutate")).map(
          (request) => (request.params as { action: string }).action,
        ),
      ).toEqual(["share", "rollback", "transfer", "disable", "remove"]);
    });
  });
});
