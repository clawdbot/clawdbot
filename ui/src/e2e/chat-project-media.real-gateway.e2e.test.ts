// Real session/worktree admission, media authorization, and browser image decoding.
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { appendTranscriptMessage } from "../../../src/config/sessions/session-accessor.js";
import { ensureGatewayOwnerProfile, setAvatar } from "../../../src/state/user-profiles.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite, tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";

const captureEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const execFileAsync = promisify(execFile);
let instance: OpenClawTestInstance | undefined;
const suite = createControlUiE2eSuite({
  name: "Control UI project media with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "control-ui-project-media",
      config: {
        gateway: { controlUi: { enabled: true } },
        agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
      },
    });
    instance = owner;
    try {
      // The first browser connection otherwise adopts the host account's name and photo.
      const profile = ensureGatewayOwnerProfile("Image Proof", { env: owner.env });
      const avatar = await readFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png"));
      expect(setAvatar(profile.id, avatar, "image/png", { env: owner.env }).ok).toBe(true);
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      await runQaGatewayFixture(
        async () => {
          throw error;
        },
        () => owner.cleanup(),
      );
      throw error;
    }
  },
});

suite.define(() => {
  it("renders project images, honors full access, and allows only the selected outside image", async () => {
    if (!instance) {
      throw new Error("Gateway fixture is not running");
    }
    const owner = instance;
    const call = async (method: string, params: Record<string, unknown>) => {
      const result = await owner.cli([
        "--no-color",
        "gateway",
        "call",
        method,
        "--params",
        JSON.stringify(params),
        "--json",
      ]);
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };
    const projectRoot = owner.state.path("project");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "README.md"), "# Synthetic image preview project\n");
    for (const args of [
      ["init", "--initial-branch=main"],
      ["add", "README.md"],
      [
        "-c",
        "user.name=Image Proof",
        "-c",
        "user.email=proof@example.invalid",
        "commit",
        "-m",
        "test: initialize synthetic project",
      ],
    ]) {
      await execFileAsync("git", args, { cwd: projectRoot, env: owner.env });
    }
    const project = await call("projects.register", {
      path: projectRoot,
      name: "Image preview proof",
    });
    const sessionKey = "agent:main:project-media-proof";
    const session = await call("sessions.create", {
      key: sessionKey,
      agentId: "main",
      projectId: project.id,
      worktree: true,
      worktreeName: "image-preview-proof",
      permissionMode: "workspace",
      label: "Synthetic image preview proof",
    });
    expect(session.ok).toBe(true);
    const worktree = session.worktree as { path: string };
    expect(typeof worktree.path).toBe("string");
    expect(worktree.path).not.toBe(projectRoot);
    const projectImage = path.join(worktree.path, ".openclaw", "tmp", "proof", "project.png");
    const outsideImage = owner.state.path("outside", "selected.png");
    const siblingImage = owner.state.path("outside", "unselected.png");
    for (const target of [projectImage, outsideImage, siblingImage]) {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png"), target);
    }
    await appendTranscriptMessage(
      { agentId: "main", sessionKey, sessionId: String(session.sessionId), env: owner.env },
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "Synthetic image preview proof. The project image belongs to this task's worktree.",
                `MEDIA:${projectImage}`,
                `MEDIA:${outsideImage}`,
                `MEDIA:${siblingImage}`,
              ].join("\n\n"),
            },
          ],
          timestamp: Date.now(),
        },
      },
    );
    const dashboard = await owner.cli(["dashboard", "--json"]);
    expect(dashboard.code, dashboard.stderr).toBe(0);
    const issued = new URL((JSON.parse(dashboard.stdout) as { browserUrl: string }).browserUrl);
    const url = new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
    url.hash = issued.hash;
    await suite.withPage(
      {
        locale: "en-US",
        viewport: { width: 1440, height: 1000 },
        serviceWorkers: "block",
        permissions: ["local-network-access"],
        ...(captureEnabled
          ? { recordVideo: { dir: suite.artifactDir, size: { width: 1440, height: 1000 } } }
          : {}),
      },
      async ({ page }) => {
        const decoded = async (image: Locator) =>
          (await image.count()) === 1
            ? image.evaluate((element) =>
                element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
              )
            : 0;
        const capture = async (name: string) => {
          if (captureEnabled) {
            await page.screenshot({ path: path.join(suite.artifactDir, name) });
          }
        };
        const open = async () => {
          expect((await page.goto(url.toString()))?.status()).toBe(200);
          await waitForControlUiGatewayReady(page);
          await page
            .getByText(
              "Synthetic image preview proof. The project image belongs to this task's worktree.",
              { exact: true },
            )
            .waitFor();
        };
        await open();
        const projectPreview = page.locator('img.chat-message-image[src*="project.png"]');
        // Capture the original denial as well as the repaired state with this same scenario.
        await expect
          .poll(
            async () =>
              (await page.getByText("Outside allowed folders", { exact: false }).count()) > 0 ||
              ((await projectPreview.count()) > 0 && (await decoded(projectPreview)) > 0),
          )
          .toBe(true);
        await capture("01-project-workspace.png");
        await expect.poll(() => decoded(projectPreview)).toBeGreaterThan(0);
        await capture("01-project-workspace-ready.png");
        const selected = page
          .locator(".chat-assistant-attachment-card")
          .filter({ has: page.getByText("selected.png", { exact: true }) });
        const other = page
          .locator(".chat-assistant-attachment-card")
          .filter({ hasText: "unselected.png" });
        await expect
          .poll(() => page.getByRole("button", { name: "Allow image", exact: true }).count())
          .toBe(2);
        const selectedTitle = selected.locator(".chat-assistant-attachment-card__title");
        await selectedTitle.hover();
        await expect.poll(() => tooltipTitleText(selectedTitle)).toContain(outsideImage);
        await page
          .locator("openclaw-tooltip .tooltip-content")
          .filter({ hasText: outsideImage })
          .waitFor({ state: "visible" });
        await capture("02-outside-path-and-allow.png");
        await selected.getByRole("button", { name: "Allow image", exact: true }).click();
        const allowedPreview = page.locator(
          'img.chat-message-image[src*="selected.png"]:not([src*="unselected.png"])',
        );
        await expect.poll(() => decoded(allowedPreview)).toBeGreaterThan(0);
        expect(await other.getByRole("button", { name: "Allow image", exact: true }).count()).toBe(
          1,
        );
        await capture("03-selected-image-allowed.png");

        const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        const permissionTrigger = pane.locator('[data-chat-permission-select="true"]');
        const selectPermission = async (mode: "full" | "workspace") => {
          await permissionTrigger.click();
          await pane.locator(`[data-chat-permission-option="${mode}"]`).click();
          await expect
            .poll(() => permissionTrigger.getAttribute("data-chat-select-value"))
            .toBe(mode);
          await expect.poll(() => permissionTrigger.isEnabled()).toBe(true);
        };
        await selectPermission("full");
        for (const filename of ["project.png", "selected.png", "unselected.png"]) {
          await expect
            .poll(() => decoded(page.locator(`img.chat-message-image[src*="%2F${filename}"]`)))
            .toBeGreaterThan(0);
        }
        expect(await page.getByRole("button", { name: "Allow image", exact: true }).count()).toBe(
          0,
        );
        await capture("04-full-access-all-images.png");

        await selectPermission("workspace");
        await expect.poll(() => decoded(projectPreview)).toBeGreaterThan(0);
        await expect
          .poll(() => page.getByRole("button", { name: "Allow image", exact: true }).count())
          .toBe(2);
        await capture("05-workspace-protection-restored.png");
        if (captureEnabled) {
          await writeFile(
            path.join(suite.artifactDir, "evidence.json"),
            JSON.stringify(
              {
                sessionKey,
                projectWorkspaceRendered: true,
                outsidePathTooltip: true,
                selectedImageAllowed: true,
                siblingRemainedBlocked: true,
                fullAccessRenderedAll: true,
                restoredProtectionBlockedOutside: true,
              },
              null,
              2,
            ),
          );
        }
      },
    );
  });
});
