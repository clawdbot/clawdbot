// Control UI tests cover the full-page new-session draft and its place picker
// against a mocked Gateway: sidebar entry, fs.listDir browsing, and the final
// sessions.create payload.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "cloud-worker-session",
);

const WORKSPACE = "/home/peter/openclaw";
const PICKED = "/home/peter/openclaw/packages";
const SOURCE_REPO = "/tmp/source-repo";
const TARGET_REPO = "/tmp/target-repo";
const REFRESHED_RESEARCH_WORKSPACE = "/home/peter/research-next";
const NODE_HOME = "/Users/peter";
const NODE_PICKED = "/Users/peter/Projects";
const NODE_UNC = "\\\\server\\share\\repo";
const EXEC_ONLY_PICKED = "C:\\Users\\peter\\repo";

const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
const SESSION_LIST_DEFAULTS = {
  contextTokens: null,
  model: "gpt-5.5",
  modelProvider: "openai",
};

async function captureUiProof(page: Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(uiProofArtifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(uiProofArtifactDir, fileName),
  });
}

async function pastePng(target: Locator, count = 1) {
  await target.evaluate(
    (element, { base64, fileCount }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const clipboard = new DataTransfer();
      for (let index = 0; index < fileCount; index += 1) {
        const fileName = fileCount === 1 ? "pixel.png" : `pixel-${index + 1}.png`;
        clipboard.items.add(new File([bytes], fileName, { type: "image/png" }));
      }
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
      );
    },
    { base64: ONE_PIXEL_PNG_B64, fileCount: count },
  );
}

async function replaceGatewayClient(page: Page) {
  await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      runtime?: { context: { gateway: { connect: () => void } } };
    };
    if (!app.runtime) {
      throw new Error("OpenClaw application runtime is unavailable");
    }
    app.runtime.context.gateway.connect();
  });
}

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI new-session page mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("pastes an image into the draft and forwards it with the initial turn", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.create": { key: "agent:main:image-draft", runStarted: true },
      },
    });
    try {
      await page.goto(`${server.baseUrl}new`);
      const message = page.locator(".new-session-page__message");
      await message.waitFor();
      await pastePng(message);

      await page.locator('.chat-attachment-thumb img[alt="Attachment preview"]').waitFor();
      await page.getByRole("button", { name: "Start thread" }).click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "",
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "pixel.png",
            content: ONE_PIXEL_PNG_B64,
          },
        ],
      });
    } finally {
      await context.close();
    }
  });

  it("shows the initial prompt while the newly created session is still running", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:visible-initial-prompt";
    const message = "keep this prompt visible while the agent works";
    const activeOutputTimestamp = Date.now() + 60_000;
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.create": { key: sessionKey, runStarted: true },
        "chat.history": {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "active-tool-call",
                  name: "read",
                  arguments: { path: "SKILL.md" },
                },
              ],
              timestamp: activeOutputTimestamp,
              __openclaw: { id: "active-assistant", seq: 2 },
            },
            {
              role: "toolResult",
              toolCallId: "active-tool-call",
              toolName: "read",
              content: [{ type: "text", text: "working" }],
              timestamp: activeOutputTimestamp + 1,
              __openclaw: { id: "active-tool-result", seq: 3 },
            },
          ],
          sessionId: "visible-initial-prompt",
          sessionInfo: { hasActiveRun: true, key: sessionKey, status: "running" },
        },
      },
    });
    try {
      await page.goto(`${server.baseUrl}new`);
      await page.locator(".new-session-page__message").fill(message);
      await page.getByRole("button", { name: "Start thread" }).click();
      await page.waitForURL((url) => url.searchParams.get("session") === sessionKey, {
        timeout: 30_000,
      });
      await gateway.waitForRequest("chat.history");
      await page.getByText("SKILL.md", { exact: true }).waitFor();

      await expect.poll(() => page.locator(".chat-group.user").textContent()).toContain(message);
      const userRow = await page.locator(".chat-group.user").boundingBox();
      const toolRow = await page.getByText("SKILL.md", { exact: true }).boundingBox();
      expect(userRow).not.toBeNull();
      expect(toolRow).not.toBeNull();
      if (!userRow || !toolRow) {
        throw new Error("expected visible prompt and tool rows");
      }
      expect(userRow.y).toBeLessThan(toolRow.y);
    } finally {
      await context.close();
    }
  });

  it("waits for pasted image reads before enabling session creation", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const readAsDataUrl = Object.getOwnPropertyDescriptor(FileReader.prototype, "readAsDataURL")
        ?.value as FileReader["readAsDataURL"];
      FileReader.prototype.readAsDataURL = function (blob: Blob) {
        (globalThis as unknown as { finishPastedImageRead?: () => void }).finishPastedImageRead =
          () => readAsDataUrl.call(this, blob);
      };
    });
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.create": { key: "agent:main:delayed-image-draft", runStarted: true },
      },
    });
    try {
      await page.goto(`${server.baseUrl}new`);
      const composer = page.locator(".new-session-page__message");
      const submit = page.getByRole("button", { name: "Start thread" });
      await composer.fill("include the image that is still loading");
      await pastePng(composer);

      await expect.poll(() => submit.isDisabled()).toBe(true);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await page.evaluate(() => {
        const finish = (globalThis as unknown as { finishPastedImageRead?: () => void })
          .finishPastedImageRead;
        if (!finish) {
          throw new Error("Pasted image read was not started");
        }
        finish();
      });

      await page.locator('.chat-attachment-thumb img[alt="Attachment preview"]').waitFor();
      await expect.poll(() => submit.isEnabled()).toBe(true);
      await submit.click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        message: "include the image that is still loading",
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
      });
    } finally {
      await context.close();
    }
  });

  it("releases a completed file when the rest of its pasted batch is aborted", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const readAsDataUrl = Object.getOwnPropertyDescriptor(FileReader.prototype, "readAsDataURL")
        ?.value as FileReader["readAsDataURL"];
      let readCount = 0;
      FileReader.prototype.readAsDataURL = function (blob: Blob) {
        readCount += 1;
        if (readCount === 1) {
          readAsDataUrl.call(this, blob);
        }
      };
      const createObjectURL = URL.createObjectURL.bind(URL);
      const revokeObjectURL = URL.revokeObjectURL.bind(URL);
      const proof = { created: 0, revoked: 0 };
      (globalThis as unknown as { attachmentUrlProof: typeof proof }).attachmentUrlProof = proof;
      URL.createObjectURL = (blob: Blob) => {
        proof.created += 1;
        return createObjectURL(blob);
      };
      URL.revokeObjectURL = (url: string) => {
        proof.revoked += 1;
        revokeObjectURL(url);
      };
    });
    await installMockGateway(page);
    try {
      await page.goto(`${server.baseUrl}new`);
      const composer = page.locator(".new-session-page__message");
      await pastePng(composer, 2);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (globalThis as unknown as { attachmentUrlProof: { created: number } })
                .attachmentUrlProof.created,
          ),
        )
        .toBe(1);

      await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: { context: { navigate: (routeId: string) => void } };
        };
        app.runtime?.context.navigate("chat");
      });
      await page.waitForURL((url) => url.pathname.endsWith("/chat"));
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (globalThis as unknown as { attachmentUrlProof: { revoked: number } })
                .attachmentUrlProof.revoked,
          ),
        )
        .toBe(1);
    } finally {
      await context.close();
    }
  });

  it("releases pasted image previews after remove, reset, disconnect, and success", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const createObjectURL = URL.createObjectURL.bind(URL);
      const revokeObjectURL = URL.revokeObjectURL.bind(URL);
      const proof = { created: 0, revoked: 0 };
      (globalThis as unknown as { attachmentUrlProof: typeof proof }).attachmentUrlProof = proof;
      URL.createObjectURL = (blob: Blob) => {
        proof.created += 1;
        return createObjectURL(blob);
      };
      URL.revokeObjectURL = (url: string) => {
        proof.revoked += 1;
        revokeObjectURL(url);
      };
    });
    await installMockGateway(page, {
      methodResponses: {
        "agents.list": {
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
          agents: [
            { id: "main", name: "Main" },
            { id: "writer", name: "Writer" },
          ],
        },
        "sessions.create": { key: "agent:main:preview-cleanup", runStarted: true },
      },
    });
    const proof = () =>
      page.evaluate(
        () =>
          (globalThis as unknown as { attachmentUrlProof: { created: number; revoked: number } })
            .attachmentUrlProof,
      );
    const navigate = (routeId: string, search = "") =>
      page.evaluate(
        ({ targetRouteId, targetSearch }) => {
          const app = document.querySelector("openclaw-app") as HTMLElement & {
            runtime?: {
              context: {
                navigate: (routeId: string, options?: { search?: string }) => void;
              };
            };
          };
          if (!app.runtime) {
            throw new Error("OpenClaw application runtime is unavailable");
          }
          app.runtime.context.navigate(targetRouteId, { search: targetSearch });
        },
        { targetRouteId: routeId, targetSearch: search },
      );

    try {
      await page.goto(`${server.baseUrl}new`);
      const composer = page.locator(".new-session-page__message");

      await pastePng(composer);
      await page.locator('.chat-attachment-thumb img[alt="Attachment preview"]').waitFor();
      await page.getByRole("button", { name: "Remove attachment" }).click();
      await expect.poll(async () => (await proof()).revoked).toBe(1);

      await pastePng(composer);
      await page.locator('.chat-attachment-thumb img[alt="Attachment preview"]').waitFor();
      const agentDropdown = page.locator(".new-session-page__select--agent wa-dropdown");
      await page.locator(".new-session-page__select--agent .agent-select__trigger").click();
      await expect
        .poll(() =>
          agentDropdown.evaluate((dropdown) => (dropdown as HTMLElement & { open: boolean }).open),
        )
        .toBe(true);
      await navigate("new-session", "?agent=main&catalog=missing");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                document.querySelector(".new-session-page__select--agent wa-dropdown") as
                  | (HTMLElement & { open: boolean })
                  | null
              )?.open ?? false,
          ),
        )
        .toBe(false);
      await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(0);
      await expect.poll(async () => (await proof()).revoked).toBe(2);

      await navigate("new-session");
      await composer.waitFor();
      await pastePng(composer);
      await page.locator('.chat-attachment-thumb img[alt="Attachment preview"]').waitFor();
      await navigate("chat");
      await page.waitForURL((url) => url.pathname.endsWith("/chat"));
      await expect.poll(async () => (await proof()).revoked).toBe(3);

      await navigate("new-session");
      await composer.waitFor();
      await pastePng(composer);
      await page.locator('.chat-attachment-thumb img[alt="Attachment preview"]').waitFor();
      await page.getByRole("button", { name: "Start thread" }).click();
      await page.waitForURL(
        (url) => url.searchParams.get("session") === "agent:main:preview-cleanup",
      );
      await expect.poll(async () => await proof()).toEqual({ created: 4, revoked: 4 });
    } finally {
      await context.close();
    }
  });

  it("selects the model for a plain new session", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      models: [
        { id: "gpt-5.5", name: "GPT 5.5", provider: "openai" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
      ],
      methodResponses: {
        "sessions.create": { key: "agent:main:model-draft", runStarted: true },
      },
    });
    try {
      await page.goto(`${server.baseUrl}new`);
      const modelSelect = page.locator('[data-chat-model-select="true"]');
      await modelSelect.waitFor();
      expect(
        await page.locator('.new-session-page__composer [data-chat-model-select="true"]').count(),
      ).toBe(1);
      expect(
        await page.locator('.new-session-page__triggers [data-chat-model-select="true"]').count(),
      ).toBe(0);
      await modelSelect.click();
      const pickerOpen = () =>
        modelSelect.evaluate(
          (element) => element.closest("details")?.hasAttribute("open") ?? false,
        );
      const modelTriggerBox = await modelSelect.boundingBox();
      const modelMenuBox = await page
        .locator(".chat-controls__inline-select-menu--combined")
        .boundingBox();
      expect(modelTriggerBox).not.toBeNull();
      expect(modelMenuBox).not.toBeNull();
      expect(modelMenuBox?.x ?? 0).toBeLessThan(modelTriggerBox?.x ?? 0);
      expect((modelMenuBox?.x ?? 0) + (modelMenuBox?.width ?? 0)).toBeCloseTo(
        (modelTriggerBox?.x ?? 0) + (modelTriggerBox?.width ?? 0),
        0,
      );
      await page.locator('[data-chat-model-provider="anthropic"]').click();
      await expect.poll(pickerOpen).toBe(true);
      await page.locator('[data-chat-model-option="anthropic/claude-sonnet-4-6"]').click();
      // Inside changes stay grouped; only explicit light-dismissal closes the picker.
      await expect.poll(pickerOpen).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(pickerOpen).toBe(false);
      await expect
        .poll(() => modelSelect.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await modelSelect.click();
      await expect.poll(pickerOpen).toBe(true);
      await page.mouse.click(8, 8);
      await expect.poll(pickerOpen).toBe(false);
      await page.locator(".new-session-page__message").fill("use this model");
      await page.getByRole("button", { name: "Start thread" }).click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        message: "use this model",
        model: "anthropic/claude-sonnet-4-6",
      });
    } finally {
      await context.close();
    }
  });

  it("drafts a session with a browsed folder and creates it on first message", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "main",
              identity: { name: "Main" },
              name: "Main",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "fs.listDir": {
          cases: [
            {
              match: { path: WORKSPACE },
              response: {
                path: WORKSPACE,
                parent: "/home/peter",
                home: "/home/peter",
                entries: [
                  { name: "packages", path: PICKED },
                  { name: ".git", path: `${WORKSPACE}/.git`, hidden: true },
                ],
              },
            },
            {
              match: { path: PICKED },
              response: {
                path: PICKED,
                parent: WORKSPACE,
                home: "/home/peter",
                entries: [],
              },
            },
          ],
        },
        "sessions.create": { key: "agent:main:draft-e2e" },
      },
    });

    try {
      // Deep-link to /new: the page loads agents via agents.list (the sidebar
      // "+" navigates to the same route with ?agent=<id>).
      const response = await page.goto(`${server.baseUrl}new`);
      expect(response?.status()).toBe(200);
      // The draft page shows the start-screen welcome hero for the agent.
      await page.getByRole("heading", { name: "Main" }).waitFor();
      await page.locator(".new-session-page__message").waitFor();

      // Unified layout: the trigger row (menus above the composer) sits
      // inside the start-screen welcome, below the hero.
      const heroBox = await page.locator(".agent-chat__welcome h2").boundingBox();
      const triggersBox = await page.locator(".new-session-page__triggers").boundingBox();
      const composerBox = await page.locator(".new-session-page__composer").boundingBox();
      const modelBox = await page.locator('[data-chat-model-select="true"]').boundingBox();
      const modelWrapperBox = await page
        .locator(".new-session-page__composer .chat-composer-model-control")
        .boundingBox();
      const footerBox = await page
        .locator(".new-session-page__composer .agent-chat__composer-footer")
        .boundingBox();
      expect(heroBox).not.toBeNull();
      expect(triggersBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      expect(modelBox).not.toBeNull();
      expect(modelWrapperBox).not.toBeNull();
      expect(footerBox).not.toBeNull();
      expect((heroBox?.y ?? 0) + (heroBox?.height ?? 0)).toBeLessThanOrEqual(
        (triggersBox?.y ?? 0) + 1,
      );
      expect((triggersBox?.y ?? 0) + (triggersBox?.height ?? 0)).toBeLessThanOrEqual(
        (composerBox?.y ?? 0) + 1,
      );
      expect(
        await page.locator(".new-session-page__composer .agent-chat__composer-footer").count(),
      ).toBe(1);
      expect(
        await page
          .locator('[data-chat-model-select="true"]')
          .evaluate((element) => element.closest(".agent-chat__composer-footer") != null),
      ).toBe(true);
      expect(modelWrapperBox?.x ?? 0).toBeGreaterThan(
        (footerBox?.x ?? 0) + (footerBox?.width ?? 0) / 2,
      );
      expect(
        (footerBox?.x ?? 0) +
          (footerBox?.width ?? 0) -
          ((modelWrapperBox?.x ?? 0) + (modelWrapperBox?.width ?? 0)),
      ).toBeLessThanOrEqual(12);
      expect(triggersBox?.x).toBeCloseTo(composerBox?.x ?? 0, 0);
      expect(triggersBox?.width).toBeCloseTo(composerBox?.width ?? 0, 0);
      expect(composerBox?.width).toBeCloseTo(48 * 16, 0);
      expect(await page.locator(".new-session-page__message").getAttribute("rows")).toBe("1");

      // The place trigger labels the workspace and opens the unified menu.
      const placeSelect = page.locator("wa-popover.new-session-page__place-popover");
      const placeTrigger = page.locator("#new-session-place-trigger");
      await expect
        .poll(() => placeTrigger.locator(".new-session-page__trigger-label").textContent())
        .toBe("openclaw");

      // Browse from the workspace, descend one level, then adopt the folder.
      await placeTrigger.click();
      await placeSelect.getByRole("button", { name: "Browse folders" }).click();
      await page.locator(".new-session-page__browser-entry", { hasText: "packages" }).click();
      await expect
        .poll(() => page.locator("input.new-session-page__browser-path").inputValue())
        .toBe(PICKED);
      await page.getByRole("button", { name: "Use this folder" }).click();

      // The adopted folder closes the menu and updates the trigger label.
      await expect.poll(() => placeSelect.getAttribute("open")).toBeNull();
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.id))
        .toBe("new-session-place-trigger");
      await expect
        .poll(() => placeTrigger.locator(".new-session-page__trigger-label").textContent())
        .toBe("packages");

      // Git-backed custom folders stay direct until the user explicitly chooses isolation.
      await expect.poll(() => placeTrigger.getAttribute("data-worktree")).toBe("false");
      await placeTrigger.click();
      const worktreeItem = page.getByRole("button", { name: "Worktree" });
      await expect.poll(() => worktreeItem.getAttribute("aria-pressed")).toBe("false");
      expect(await worktreeItem.isEnabled()).toBe(true);
      await worktreeItem.click();
      await expect.poll(() => placeTrigger.getAttribute("data-worktree")).toBe("true");
      await page.keyboard.press("Escape");
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.id))
        .toBe("new-session-place-trigger");

      // Pointer light-dismiss still retires the unified popover after its
      // asynchronous hide animation completes.
      await placeTrigger.click();
      const afterPointerHide = placeSelect.evaluate(
        (element) =>
          new Promise<void>((resolve) => {
            element.addEventListener("wa-after-hide", () => resolve(), { once: true });
          }),
      );
      await page.locator(".agent-chat__welcome h2").click();
      await afterPointerHide;
      await expect.poll(() => placeSelect.getAttribute("open")).toBeNull();

      const message = page.locator(".new-session-page__message");
      await message.fill("fix the flaky test");
      await page.getByRole("button", { name: "Start thread" }).click();

      const createRequest = await gateway.waitForRequest("sessions.create");
      expect(createRequest.params).toMatchObject({
        agentId: "main",
        message: "fix the flaky test",
        worktree: true,
        worktreeBaseRef: "main",
        cwd: PICKED,
      });

      await expect
        .poll(() => new URL(page.url()).search)
        .toContain(`session=${encodeURIComponent("agent:main:draft-e2e")}`);
    } finally {
      await context.close();
    }
  });

  it("runs directly in a custom non-Git Gateway folder", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "main",
              identity: { name: "Main" },
              name: "Main",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "environments.list": {
          environments: [],
          profiles: [{ id: "aws", providerId: "crabbox" }],
        },
        "fs.listDir": { path: WORKSPACE, home: "/home/peter", entries: [] },
        "worktrees.branches": {
          cases: [
            {
              match: { repoRoot: WORKSPACE },
              response: {
                branches: [{ kind: "local", name: "main" }],
                defaultBranch: "main",
                repositoryStatus: "git",
              },
            },
            {
              match: { repoRoot: "/home" },
              response: { branches: [], repositoryStatus: "not_git" },
            },
          ],
        },
        "sessions.create": { key: "agent:main:plain-folder" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const trigger = page.locator("#new-session-place-trigger");
      const place = page.locator("wa-popover.new-session-page__place-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Browse folders" }).click();
      await page.locator("input.new-session-page__browser-path").fill("/home");
      await page.getByRole("button", { name: "Use this folder" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).at(-1)?.params)
        .toEqual({ repoRoot: "/home", includeRepositoryStatus: true });
      await expect
        .poll(() => trigger.locator(".new-session-page__trigger-label").textContent())
        .toBe("home · Gateway · local");

      await trigger.click();
      expect(await place.getByRole("button", { name: "Worktree" }).count()).toBe(0);
      const cloud = place.getByRole("button", { name: "Cloud · aws" });
      expect(await cloud.isDisabled()).toBe(true);
      expect(await cloud.getAttribute("title")).toBe("Cloud workers require a managed worktree");
      await page.keyboard.press("Escape");

      await page.locator(".new-session-page__message").fill("clone and inspect this project");
      await page.getByRole("button", { name: "Start thread" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        cwd: "/home",
        message: "clone and inspect this project",
      });
      expect(create.params).not.toHaveProperty("worktree");
      expect(create.params).not.toHaveProperty("worktreeBaseRef");
    } finally {
      await context.close();
    }
  });

  it("hides the destination axis when the Gateway is the only place", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "node.list": { nodes: [] },
        "environments.list": { environments: [], profiles: [] },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await gateway.waitForRequest("node.list");
      const trigger = page.locator("#new-session-place-trigger");
      await expect
        .poll(() => trigger.locator(".new-session-page__trigger-label").textContent())
        .toBe("openclaw");
      await trigger.click();
      const place = page.locator("wa-popover.new-session-page__place-popover");
      expect(await place.getByText("Places", { exact: true }).count()).toBe(0);
      await place.getByText("Runs on Gateway · local", { exact: true }).waitFor();
    } finally {
      await context.close();
    }
  });

  it("uses advertised system info for Gateway place labels", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      featureMethods: ["chat.metadata", "chat.startup", "system.info"],
      methodResponses: {
        "system.info": {
          machineName: "Peters-Mac-Studio",
          hostname: "peters-mac-studio.local",
          platform: "darwin",
        },
        "node.list": {
          nodes: [
            {
              nodeId: "macbook",
              displayName: "MacBook",
              connected: true,
              commands: ["system.run"],
            },
          ],
        },
        "environments.list": { environments: [], profiles: [] },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await gateway.waitForRequest("system.info");
      const trigger = page.locator("#new-session-place-trigger");
      await expect
        .poll(() => trigger.locator(".new-session-page__trigger-label").textContent())
        .toBe("openclaw · Gateway · Peters-Mac-Studio");
      await trigger.click();
      const place = page.locator("wa-popover.new-session-page__place-popover");
      await place.getByRole("button", { name: "Gateway · Peters-Mac-Studio" }).waitFor();
      await place.getByRole("button", { name: "Browse folders" }).click();
      await expect
        .poll(() =>
          page.locator("input.new-session-page__browser-path").getAttribute("placeholder"),
        )
        .toBe("Gateway · Peters-Mac-Studio");

      await gateway.setMethodResponse("node.list", { nodes: [] });
      const nodeRequests = (await gateway.getRequests("node.list")).length;
      await replaceGatewayClient(page);
      await expect
        .poll(async () => (await gateway.getRequests("node.list")).length)
        .toBeGreaterThan(nodeRequests);
      await expect
        .poll(() => trigger.locator(".new-session-page__trigger-label").textContent())
        .toBe("openclaw");
      await trigger.click();
      await place.getByText("Runs on Gateway · Peters-Mac-Studio", { exact: true }).waitFor();
    } finally {
      await context.close();
    }
  });

  it("disambiguates duplicate node names without changing the selected chip", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "node.list": {
          nodes: [
            {
              nodeId: "11111111aaaaaaaa",
              displayName: "Mac Studio",
              platform: "darwin",
              modelIdentifier: "Mac14,12",
              remoteIp: "192.168.1.11",
              connected: true,
              commands: ["system.run"],
            },
            {
              nodeId: "22222222bbbbbbbb",
              displayName: "Mac Studio",
              platform: "darwin",
              modelIdentifier: "Mac15,14",
              remoteIp: "192.168.1.12",
              connected: true,
              commands: ["system.run"],
            },
            {
              nodeId: "33333333cccccccc",
              displayName: "iPhone",
              platform: "iOS 26.4",
              deviceFamily: "iPhone",
              modelIdentifier: "iPhone17,2",
              remoteIp: "192.168.1.30",
              connected: true,
              commands: ["system.run"],
            },
          ],
        },
        "environments.list": { environments: [], profiles: [] },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await gateway.waitForRequest("node.list");
      const trigger = page.locator("#new-session-place-trigger");
      await trigger.click();
      const first = page.locator('[data-value="node:11111111aaaaaaaa"]');
      const second = page.locator('[data-value="node:22222222bbbbbbbb"]');
      const phone = page.locator('[data-value="node:33333333cccccccc"]');
      await expect.poll(() => first.locator(".session-menu__sub").textContent()).toBe("Mac14,12");
      await expect.poll(() => second.locator(".session-menu__sub").textContent()).toBe("Mac15,14");
      await expect.poll(() => phone.locator(".session-menu__text").textContent()).toBe("iPhone");
      expect(await first.locator(".session-menu__icon svg").count()).toBe(1);
      expect(await second.locator(".session-menu__icon svg").count()).toBe(1);
      expect(await phone.locator(".session-menu__icon svg").count()).toBe(1);
      expect(await first.getAttribute("title")).toBe("macOS · Mac14,12 · 192.168.1.11");
      expect(await second.getAttribute("title")).toContain("192.168.1.12");
      await second.click();
      await expect
        .poll(() => trigger.locator(".new-session-page__trigger-label").textContent())
        .toBe("Agent workspace · Mac Studio");
      expect(await trigger.textContent()).not.toContain("Mac15,14");
      expect(await trigger.textContent()).not.toContain("192.168.1.12");
    } finally {
      await context.close();
    }
  });

  it("disambiguates duplicate recent basenames and applies the selected path", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "node.list": { nodes: [] },
        "environments.list": { environments: [], profiles: [] },
        "sessions.list": {
          count: 2,
          defaults: SESSION_LIST_DEFAULTS,
          path: "",
          sessions: [
            { key: "agent:main:a", kind: "direct", updatedAt: 2, execCwd: "/a/openclaw" },
            { key: "agent:main:b", kind: "direct", updatedAt: 1, execCwd: "/b/openclaw" },
          ],
          ts: Date.now(),
        },
        "sessions.create": { key: "agent:main:recent-collision" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await gateway.waitForRequest("node.list");
      const trigger = page.locator("#new-session-place-trigger");
      await trigger.click();
      const first = page.locator('[data-value="recent::/a/openclaw"]');
      const second = page.locator('[data-value="recent::/b/openclaw"]');
      await expect.poll(() => first.locator(".session-menu__sub").textContent()).toBe("a");
      await expect.poll(() => second.locator(".session-menu__sub").textContent()).toBe("b");
      await second.click();
      await page.locator(".new-session-page__message").fill("continue in work checkout");
      await page.getByRole("button", { name: "Start thread" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        cwd: "/b/openclaw",
        message: "continue in work checkout",
      });
    } finally {
      await context.close();
    }
  });

  it("applies a recent folder and node as one place", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "node.list": {
          nodes: [
            {
              nodeId: "macbook",
              displayName: "MacBook",
              connected: true,
              commands: ["system.run", "fs.listDir"],
            },
          ],
        },
        "sessions.list": {
          count: 2,
          defaults: SESSION_LIST_DEFAULTS,
          path: "",
          sessions: [
            {
              key: "agent:main:recent-node",
              kind: "direct",
              updatedAt: 2,
              execCwd: NODE_PICKED,
              execNode: "macbook",
            },
            {
              key: "agent:main:workspace",
              kind: "direct",
              updatedAt: 1,
              execCwd: WORKSPACE,
            },
          ],
          ts: Date.now(),
        },
        "sessions.create": { key: "agent:main:recent-place" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await gateway.waitForRequest("node.list");
      const trigger = page.locator("#new-session-place-trigger");
      await trigger.click();
      await page
        .locator("wa-popover.new-session-page__place-popover")
        .getByRole("button", { name: "Projects · MacBook", exact: true })
        .click();
      await expect
        .poll(() => trigger.locator(".new-session-page__trigger-label").textContent())
        .toBe("Projects · MacBook");

      await page.locator(".new-session-page__message").fill("continue on the recent node");
      await page.getByRole("button", { name: "Start thread" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        cwd: NODE_PICKED,
        execNode: "macbook",
        message: "continue on the recent node",
      });
    } finally {
      await context.close();
    }
  });

  it("returns from the browse root to the place menu", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "fs.listDir": {
          path: WORKSPACE,
          home: WORKSPACE,
          entries: [],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      const trigger = page.locator("#new-session-place-trigger");
      const place = page.locator("wa-popover.new-session-page__place-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Browse folders" }).click();
      await gateway.waitForRequest("fs.listDir");
      await place.getByRole("button", { name: "Parent folder" }).click();
      await place.getByRole("button", { name: "Worktree" }).waitFor();
      expect(await place.getAttribute("open")).not.toBeNull();

      await place.getByRole("button", { name: "Browse folders" }).click();
      await page.locator("input.new-session-page__browser-path").press("Escape");
      await place.getByRole("button", { name: "Worktree" }).waitFor();
      expect(await place.getAttribute("open")).not.toBeNull();
    } finally {
      await context.close();
    }
  });

  it("dispatches a cloud target before sending its first turn and shows placement", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:cloud:cloud-e2e";
    const gateway = await installMockGateway(page, {
      defaultAgentId: "cloud",
      deferredMethods: ["sessions.dispatch"],
      featureMethods: ["chat.metadata", "chat.startup", "sessions.reclaim"],
      workspaceGit: true,
      sessionKey: "agent:cloud:neutral-e2e",
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "cloud",
              identity: { name: "Cloud" },
              name: "Cloud",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "cloud",
          mainKey: "main",
          scope: "agent",
        },
        "environments.list": {
          environments: [],
          profiles: [{ id: "aws", providerId: "crabbox" }],
        },
        "fs.listDir": {
          path: WORKSPACE,
          parent: "/home/peter",
          home: "/home/peter",
          entries: [],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.create": { key: sessionKey },
        "sessions.dispatch": {
          ok: true,
          key: sessionKey,
          sessionId: "session-cloud-e2e",
          placement: {
            state: "active",
            generation: 1,
            createdAtMs: 1,
            updatedAtMs: 2,
            stateChangedAtMs: 2,
            environmentId: "worker-1",
            activeOwnerEpoch: 1,
            workerBundleHash: "a".repeat(64),
            workspaceBaseManifestRef: "manifest-1",
            remoteWorkspaceDir: "/workspace",
          },
        },
        "sessions.describe": { session: {} },
        "sessions.delete": { ok: true, deleted: true },
        "sessions.reclaim": { ok: true },
        "sessions.send": { runId: "run-cloud-e2e", status: "started" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      expect(
        await page.evaluate(() => ({
          hasSubtleCrypto: Boolean(globalThis.crypto.subtle),
          isSecureContext: globalThis.isSecureContext,
        })),
      ).toEqual({ hasSubtleCrypto: true, isSecureContext: true });
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-place-trigger").click();
      const place = page.locator("wa-popover.new-session-page__place-popover");
      await place.getByRole("button", { name: "Cloud · aws" }).click();
      const trigger = page.locator("#new-session-place-trigger");
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");
      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");
      await expect.poll(() => page.getByLabel("Base branch").inputValue()).toBe("main");

      const modelSelect = page.locator(
        '.new-session-page__composer [data-chat-model-select="true"]',
      );
      await modelSelect.click();
      await expect.poll(() => modelSelect.getAttribute("data-chat-thinking-select")).toBe("true");
      const thinkingSlider = page.locator(
        '.new-session-page__composer [data-chat-thinking-slider="true"]',
      );
      await expect
        .poll(() => thinkingSlider.getAttribute("data-chat-thinking-values"))
        .toBe("off,minimal,low,medium,high");
      await expect
        .poll(() => page.locator(".new-session-page__composer [data-chat-speed-toggle]").count())
        .toBe(0);
      await thinkingSlider.press("End");
      await expect.poll(() => modelSelect.getAttribute("data-chat-thinking-value")).toBe("high");
      await captureUiProof(page, "01-cloud-thinking-level.png");
      await modelSelect.click();
      await expect
        .poll(() => modelSelect.evaluate((element) => element.closest("details")?.open ?? false))
        .toBe(false);

      // Picking a Gateway repo keeps the cloud selection: that folder is what
      // the managed worktree checks out and dispatch syncs to the worker.
      await trigger.click();
      await place.getByRole("button", { name: "Browse folders" }).click();
      await page.locator("input.new-session-page__browser-path").fill(TARGET_REPO);
      await page.getByRole("button", { name: "Use this folder" }).click();
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");
      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");
      await trigger.click();
      await expect
        .poll(() => place.locator(".new-session-page__menu-note").textContent())
        .toContain("Syncs target-repo to the cloud worker");
      await captureUiProof(page, "01-cloud-worker-target.png");
      await page.keyboard.press("Escape");

      const message = "fix the cloud-only failure";
      const composer = page.locator(".new-session-page__message");
      await composer.fill(message);
      await pastePng(composer);
      await page.locator('.chat-attachment-thumb img[alt="Attachment preview"]').waitFor();
      const startButton = page.getByRole("button", { name: "Start thread" });
      await gateway.deferNext("environments.list");
      const profileRequests = (await gateway.getRequests("environments.list")).length;
      await replaceGatewayClient(page);
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBeGreaterThan(profileRequests);
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");
      await expect.poll(() => startButton.isDisabled()).toBe(true);
      await gateway.rejectDeferred("environments.list", {
        code: "UNAVAILABLE",
        message: "profile lookup unavailable",
      });
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");
      await expect.poll(() => startButton.isDisabled()).toBe(true);
      const failedProfileRequests = (await gateway.getRequests("environments.list")).length;
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBeGreaterThan(failedProfileRequests);
      await expect.poll(() => startButton.isDisabled()).toBe(false);

      await startButton.click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "cloud",
        message: "",
        worktree: true,
        worktreeBaseRef: "main",
        cwd: TARGET_REPO,
        thinkingLevel: "high",
      });
      expect(create.params).not.toHaveProperty("attachments");
      await gateway.waitForRequest("sessions.dispatch");
      await gateway.rejectDeferred("sessions.dispatch", {
        code: "UNAVAILABLE",
        message: "allocation response lost",
      });
      await expect
        .poll(() => page.locator(".new-session-page__error").textContent())
        .toContain("cloud worker placement could not be verified");
      const alert = page.locator(".new-session-page__alert");
      await expect.poll(() => alert.getAttribute("role")).toBe("alert");
      await expect.poll(() => alert.locator("svg").count()).toBe(1);
      const [alertBox, composerBox] = await Promise.all([
        alert.boundingBox(),
        page.locator(".new-session-page__composer").boundingBox(),
      ]);
      expect(alertBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      expect(
        Math.abs(
          (alertBox?.x ?? 0) +
            (alertBox?.width ?? 0) / 2 -
            ((composerBox?.x ?? 0) + (composerBox?.width ?? 0) / 2),
        ),
      ).toBeLessThanOrEqual(1);
      await expect.poll(() => startButton.isDisabled()).toBe(false);
      await page.getByRole("button", { name: "Start thread" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.dispatch")).length)
        .toBe(2);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.delete")).toHaveLength(0);
      const dispatches = await gateway.getRequests("sessions.dispatch");
      expect(dispatches.at(-1)?.params).toEqual({
        key: sessionKey,
        agentId: "cloud",
        profileId: "aws",
      });
      const send = await gateway.waitForRequest("sessions.send");
      expect(send.params).toMatchObject({
        key: sessionKey,
        agentId: "cloud",
        message,
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
      });
      const orderedMethods = (await gateway.getRequests())
        .map((request) => request.method)
        .filter((method) =>
          ["sessions.create", "sessions.dispatch", "sessions.send"].includes(method),
        );
      expect(orderedMethods).toEqual([
        "sessions.create",
        "sessions.dispatch",
        "sessions.dispatch",
        "sessions.send",
      ]);

      await gateway.setMethodResponse("sessions.list", {
        count: 4,
        path: "",
        defaults: {},
        sessions: [
          {
            key: sessionKey,
            kind: "direct",
            label: "Cloud session",
            updatedAt: Date.now(),
            worktree: { id: "worktree-1", branch: "openclaw/cloud-e2e", repoRoot: WORKSPACE },
            placement: { state: "active" },
          },
          {
            key: "agent:cloud:managed-e2e",
            kind: "direct",
            label: "Managed session",
            updatedAt: Date.now() - 1,
            placement: { state: "active" },
          },
          {
            key: "agent:cloud:local-e2e",
            kind: "direct",
            label: "Local session",
            updatedAt: Date.now() - 2,
            placement: { state: "local" },
          },
          {
            key: "agent:cloud:neutral-e2e",
            kind: "direct",
            label: "Neutral session",
            updatedAt: Date.now() - 3,
            placement: { state: "local" },
          },
        ],
        ts: Date.now(),
      });
      await gateway.emitGatewayEvent("sessions.changed", { sessionKey, reason: "dispatch" });
      await page.goto(
        `${server.baseUrl}chat?session=${encodeURIComponent("agent:cloud:neutral-e2e")}`,
      );
      const managedSessionKey = "agent:cloud:managed-e2e";
      const sessionRow = page.locator(`[data-session-key="${managedSessionKey}"]`);
      const localSessionRow = page.locator('[data-session-key="agent:cloud:local-e2e"]');
      await sessionRow.waitFor();
      await localSessionRow.waitFor();
      const cloudPlacementBadge = sessionRow.locator('[data-placement-state="active"]');
      await cloudPlacementBadge.waitFor();
      await sessionRow.hover();
      await sessionRow.getByRole("button", { name: "Open thread menu" }).click();
      const stopWorker = page
        .locator("openclaw-session-menu")
        .getByRole("menuitem", { name: "Stop cloud worker…" });
      await stopWorker.waitFor();
      await captureUiProof(page, "02-active-cloud-worker-stop.png");
      expect(await localSessionRow.locator(".session-row-badge--cloud").count()).toBe(0);
      expect(await cloudPlacementBadge.locator("circle").count()).toBe(1);
      expect(await cloudPlacementBadge.locator("rect").count()).toBe(0);
      page.once("dialog", (dialog) => void dialog.accept());
      await stopWorker.click();
      const reclaim = await gateway.waitForRequest("sessions.reclaim");
      expect(reclaim.params).toEqual({ key: managedSessionKey, agentId: "cloud" });
    } finally {
      await context.close();
    }
  });

  it("clears cloud placement when the selected agent changes", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "cloud",
              identity: { name: "Cloud" },
              name: "Cloud",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
            {
              id: "local",
              identity: { name: "Local" },
              name: "Local",
              workspace: "/home/peter/local",
              workspaceGit: false,
            },
          ],
          defaultId: "cloud",
          mainKey: "main",
          scope: "agent",
        },
        "environments.list": {
          environments: [],
          profiles: [{ id: "aws", providerId: "crabbox" }],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-place-trigger").click();
      await page
        .locator("wa-popover.new-session-page__place-popover")
        .getByRole("button", { name: "Cloud · aws" })
        .click();
      const trigger = page.locator("#new-session-place-trigger");
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");

      await gateway.setMethodResponse("environments.list", { environments: [], profiles: [] });
      const profileRequests = (await gateway.getRequests("environments.list")).length;
      await replaceGatewayClient(page);
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBeGreaterThan(profileRequests);
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");
      await expect.poll(() => trigger.textContent()).toContain("Cloud · aws");
      await expect
        .poll(() => page.getByRole("button", { name: "Start thread" }).isDisabled())
        .toBe(true);
      await trigger.click();
      await expect
        .poll(() =>
          page
            .locator("wa-popover.new-session-page__place-popover")
            .getByRole("button", { name: "Cloud · aws" })
            .isDisabled(),
        )
        .toBe(true);
      await page.keyboard.press("Escape");

      const agentPicker = page.locator(".new-session-page__select--agent openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker
        .locator("wa-dropdown-item[data-agent-option]")
        .filter({ hasText: "Local" })
        .click();
      await page.getByRole("heading", { name: "Local" }).waitFor();
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBeNull();
      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("false");
    } finally {
      await context.close();
    }
  });

  it("restores a cloud startup after a page reload without creating another session", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const sessionKey = "agent:cloud:reload-recovery";
    const message = "resume this cloud task after reload";
    const gateway = await installMockGateway(page, {
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "cloud",
              identity: { name: "Cloud" },
              name: "Cloud",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "cloud",
          mainKey: "main",
          scope: "agent",
        },
        "environments.list": {
          environments: [],
          profiles: [{ id: "aws", providerId: "crabbox" }],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.create": { key: sessionKey },
        "sessions.dispatch": {
          ok: true,
          key: sessionKey,
          sessionId: "session-reload-recovery",
          placement: {
            state: "active",
            generation: 1,
            createdAtMs: 1,
            updatedAtMs: 2,
            stateChangedAtMs: 2,
            environmentId: "worker-reload-recovery",
            activeOwnerEpoch: 1,
            workerBundleHash: "a".repeat(64),
            workspaceBaseManifestRef: "manifest-reload-recovery",
            remoteWorkspaceDir: "/workspace",
          },
        },
        "sessions.list": {
          count: 1,
          defaults: SESSION_LIST_DEFAULTS,
          path: "",
          sessions: [{ key: sessionKey, kind: "direct", updatedAt: Date.now() }],
          ts: Date.now(),
        },
        "chat.history": {
          messages: [],
          sessionId: "session-reload-recovery",
          sessionInfo: { hasActiveRun: false, key: sessionKey, status: "done" },
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-place-trigger").click();
      await page
        .locator("wa-popover.new-session-page__place-popover")
        .getByRole("button", { name: "Cloud · aws" })
        .click();
      await page.evaluate(() => {
        const originalSetItem = sessionStorage.setItem.bind(sessionStorage);
        Storage.prototype.setItem = function (key: string, value: string) {
          if (
            key.startsWith("openclaw.new-session.cloud-recovery.v1:") ||
            key.startsWith("openclaw.control-ui-e2e.")
          ) {
            originalSetItem(key, value);
            return;
          }
          throw new DOMException("composer storage disabled", "SecurityError");
        };
      });
      await gateway.deferNext("sessions.send");
      await page.locator(".new-session-page__message").fill(message);
      await pastePng(page.locator(".new-session-page__message"));
      await page.getByRole("button", { name: "Start thread" }).click();
      const firstSend = await gateway.waitForRequest("sessions.send");
      expect(firstSend.params).toMatchObject({
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
      });
      await gateway.rejectDeferred("sessions.send", {
        code: "UNAVAILABLE",
        message: "send outcome unknown",
      });
      await expect
        .poll(() => page.locator(".new-session-page__error").textContent())
        .toContain("send outcome unknown");
      await gateway.setMethodResponse("sessions.send", {
        runId: "run-reload-recovery",
        status: "started",
      });

      await page.reload();
      await gateway.waitForRequest("environments.list");
      await expect
        .poll(() => page.locator(".new-session-page__message").inputValue())
        .toBe(message);
      await page.locator('.chat-attachment-thumb img[alt="Attachment preview"]').waitFor();
      await expect
        .poll(() => page.getByRole("button", { name: "Remove attachment" }).isDisabled())
        .toBe(true);
      await expect
        .poll(() => page.getByRole("button", { name: "Start thread" }).isDisabled())
        .toBe(false);
      await page.getByRole("button", { name: "Start thread" }).click();
      const resumedSend = await gateway.waitForRequest("sessions.send");
      expect(resumedSend.params).toMatchObject({
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
        idempotencyKey: (firstSend.params as { idempotencyKey: string }).idempotencyKey,
        key: sessionKey,
        message,
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await page.waitForURL((url) => url.searchParams.get("session") === sessionKey, {
        timeout: 30_000,
      });
    } finally {
      await context.close();
    }
  });

  it("restores cloud recovery added while the Gateway is disconnected", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "cloud",
              identity: { name: "Cloud" },
              name: "Cloud",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "cloud",
          mainKey: "main",
          scope: "agent",
        },
        "environments.list": {
          environments: [],
          profiles: [{ id: "aws", providerId: "crabbox" }],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const recoveryIdentity = await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: {
            context: {
              gateway: {
                connection: { gatewayUrl: string };
                snapshot: { client?: { recoveryScope?: string } | null };
              };
            };
          };
        };
        const gatewaySnapshot = app.runtime?.context.gateway;
        const gatewayUrl = gatewaySnapshot?.connection.gatewayUrl ?? "";
        const recoveryScope = gatewaySnapshot?.snapshot.client?.recoveryScope ?? "";
        if (!gatewayUrl || !recoveryScope) {
          throw new Error("Gateway recovery identity is unavailable");
        }
        return { gatewayUrl, recoveryScope };
      });

      await gateway.setOnline(false);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime?: { context: { gateway: { snapshot: { connected: boolean } } } };
            };
            return app.runtime?.context.gateway.snapshot.connected ?? false;
          }),
        )
        .toBe(false);
      await page.evaluate(({ gatewayUrl, recoveryScope }) => {
        sessionStorage.setItem(
          `openclaw.new-session.cloud-recovery.v1:${gatewayUrl}:${recoveryScope}`,
          JSON.stringify({
            sessionKey: "agent:cloud:offline-recovery",
            messageId: "message-offline-recovery",
            message: "restore after reconnect",
            attachments: [
              {
                type: "image",
                mimeType: "image/png",
                fileName: "pixel.png",
                content:
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
              },
            ],
            profileId: "aws",
            agentId: "cloud",
            gatewayUrl,
            recoveryScope,
            phase: "sending",
          }),
        );
      }, recoveryIdentity);

      await gateway.setOnline(true);
      await expect
        .poll(() => page.locator(".new-session-page__message").inputValue())
        .toBe("restore after reconnect");
      await page.locator('.chat-attachment-thumb img[alt="Attachment preview"]').waitFor();
      await expect
        .poll(() => page.getByRole("button", { name: "Start thread" }).isDisabled())
        .toBe(false);
      await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: {
            context: {
              gateway: {
                snapshot: {
                  client?: { recoveryScopeTracker?: { ready: boolean } } | null;
                };
              };
            };
          };
        };
        const client = app.runtime?.context.gateway.snapshot.client;
        if (!client?.recoveryScopeTracker) {
          throw new Error("Gateway recovery tracker is unavailable");
        }
        client.recoveryScopeTracker.ready = false;
        (
          document.querySelector("openclaw-new-session-page") as
            | (HTMLElement & { requestUpdate: () => void })
            | null
        )?.requestUpdate();
      });
      await expect
        .poll(() => page.getByRole("button", { name: "Start thread" }).isDisabled())
        .toBe(true);
    } finally {
      await context.close();
    }
  });

  it("retries an ambiguous cloud create with the same session key", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const message = "recover the cloud create";
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.create"],
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "cloud",
              identity: { name: "Cloud" },
              name: "Cloud",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "cloud",
          mainKey: "main",
          scope: "agent",
        },
        "environments.list": {
          environments: [],
          profiles: [{ id: "aws", providerId: "crabbox" }],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.dispatch": {
          placement: { state: "active", environmentId: "worker-create-recovery" },
        },
        "sessions.send": { runId: "run-create-recovery", status: "started" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-place-trigger").click();
      await page
        .locator("wa-popover.new-session-page__place-popover")
        .getByRole("button", { name: "Cloud · aws" })
        .click();
      await page.locator(".new-session-page__message").fill(message);
      await page.getByRole("button", { name: "Start thread" }).click();
      const firstCreate = await gateway.waitForRequest("sessions.create");
      const firstKey = (firstCreate.params as { key?: string }).key;
      expect(firstKey).toMatch(/^agent:cloud:dashboard:/);

      await page.reload();
      await gateway.waitForRequest("environments.list");
      await expect
        .poll(() => page.locator(".new-session-page__message").inputValue())
        .toBe(message);
      await page.getByRole("button", { name: "Start thread" }).click();
      const retryCreate = await gateway.waitForRequest("sessions.create");
      expect(retryCreate.params).toMatchObject({ key: firstKey, message: "", worktree: true });
      await gateway.resolveDeferred("sessions.create", { key: firstKey });

      expect(await gateway.waitForRequest("sessions.dispatch")).toMatchObject({
        params: { key: firstKey, agentId: "cloud", profileId: "aws" },
      });
      expect(await gateway.waitForRequest("sessions.send")).toMatchObject({
        params: { key: firstKey, agentId: "cloud", message },
      });
      await page.waitForURL((url) => url.searchParams.get("session") === firstKey, {
        timeout: 30_000,
      });
    } finally {
      await context.close();
    }
  });

  it("keeps the original recovery identity when a cloud create settles after reset", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const message = "preserve this late cloud create";
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.create", "sessions.delete"],
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "cloud",
              identity: { name: "Cloud" },
              name: "Cloud",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "cloud",
          mainKey: "main",
          scope: "agent",
        },
        "environments.list": {
          environments: [],
          profiles: [{ id: "aws", providerId: "crabbox" }],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
    });

    const readRecovery = () =>
      page.evaluate(() => {
        const key = Object.keys(sessionStorage).find((candidate) =>
          candidate.startsWith("openclaw.new-session.cloud-recovery.v1:"),
        );
        return key ? (JSON.parse(sessionStorage.getItem(key) ?? "null") as unknown) : null;
      });

    try {
      await page.goto(`${server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-place-trigger").click();
      await page
        .locator("wa-popover.new-session-page__place-popover")
        .getByRole("button", { name: "Cloud · aws" })
        .click();
      await page.locator(".new-session-page__message").fill(message);
      await page.getByRole("button", { name: "Start thread" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      const sessionKey = (create.params as { key: string }).key;
      const staged = await readRecovery();

      await page.evaluate(() => {
        history.pushState(null, "", "new?agent=cloud");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await gateway.resolveDeferred("sessions.create", { key: sessionKey });
      await gateway.waitForRequest("sessions.delete");
      await gateway.rejectDeferred("sessions.delete", {
        code: "UNAVAILABLE",
        message: "cleanup unavailable",
      });

      await expect
        .poll(() => page.locator(".new-session-page__error").textContent())
        .toContain("cleanup unavailable");
      const stagedIdentity = staged as { messageId: string; profileId: string; agentId: string };
      expect(await readRecovery()).toMatchObject({
        sessionKey,
        messageId: stagedIdentity.messageId,
        message,
        profileId: stagedIdentity.profileId,
        agentId: stagedIdentity.agentId,
        phase: "dispatching",
      });
    } finally {
      await context.close();
    }
  });

  it("retries an unpersisted cloud turn with its original recovery identity", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:cloud:storage-recovery";
    const message = "keep this cloud recovery task";
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.send"],
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "cloud",
              identity: { name: "Cloud" },
              name: "Cloud",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "cloud",
          mainKey: "main",
          scope: "agent",
        },
        "environments.list": {
          environments: [],
          profiles: [{ id: "aws", providerId: "crabbox" }],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.create": { key: sessionKey },
        "sessions.dispatch": {
          ok: true,
          key: sessionKey,
          sessionId: "session-storage-recovery",
          placement: {
            state: "active",
            generation: 1,
            createdAtMs: 1,
            updatedAtMs: 2,
            stateChangedAtMs: 2,
            environmentId: "worker-storage-recovery",
            activeOwnerEpoch: 1,
            workerBundleHash: "a".repeat(64),
            workspaceBaseManifestRef: "manifest-storage-recovery",
            remoteWorkspaceDir: "/workspace",
          },
        },
        "sessions.list": {
          count: 1,
          defaults: SESSION_LIST_DEFAULTS,
          path: "",
          sessions: [{ key: sessionKey, kind: "direct", updatedAt: Date.now() }],
          ts: Date.now(),
        },
        "chat.history": {
          messages: [],
          sessionId: "session-storage-recovery",
          sessionInfo: { hasActiveRun: false, key: sessionKey, status: "done" },
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-place-trigger").click();
      await page
        .locator("wa-popover.new-session-page__place-popover")
        .getByRole("button", { name: "Cloud · aws" })
        .click();
      await page.evaluate(() => {
        const originalSetItem = sessionStorage.setItem.bind(sessionStorage);
        Storage.prototype.setItem = function (key: string, value: string) {
          if (key.startsWith("openclaw.new-session.cloud-recovery.v1:")) {
            originalSetItem(key, value);
            return;
          }
          throw new DOMException("composer storage disabled", "SecurityError");
        };
      });
      await page.locator(".new-session-page__message").fill(message);
      await page.getByRole("button", { name: "Start thread" }).click();
      const firstSend = await gateway.waitForRequest("sessions.send");
      await gateway.rejectDeferred("sessions.send", {
        code: "UNAVAILABLE",
        message: "send outcome unknown",
      });

      await expect
        .poll(() => page.locator(".new-session-page__error").textContent())
        .toContain("send outcome unknown");
      await expect.poll(() => page.locator(".new-session-page__message").isDisabled()).toBe(true);
      expect(await page.locator(".new-session-page__message").inputValue()).toBe(message);
      expect(new URL(page.url()).pathname).toContain("/new");
      await gateway.setMethodResponse("environments.list", { environments: [], profiles: [] });
      const profileRequests = (await gateway.getRequests("environments.list")).length;
      await replaceGatewayClient(page);
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBeGreaterThan(profileRequests);
      await page.getByRole("button", { name: "Start thread" }).click();
      await page.waitForURL((url) => url.searchParams.get("session") === sessionKey, {
        timeout: 30_000,
      });

      const sends = await gateway.getRequests("sessions.send");
      expect(sends).toHaveLength(2);
      expect(sends[1]?.params).toMatchObject({
        idempotencyKey: (firstSend.params as { idempotencyKey: string }).idempotencyKey,
        key: sessionKey,
        message,
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      const dispatches = await gateway.getRequests("sessions.dispatch");
      expect(dispatches).toHaveLength(2);
      expect(dispatches[1]?.params).toMatchObject({ profileId: "aws" });
    } finally {
      await context.close();
    }
  });

  it("creates a catalog-targeted draft with its advertised model", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "main",
              identity: { name: "Main" },
              name: "Main",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
            {
              id: "research",
              identity: { name: "Research" },
              name: "Research",
              workspace: "/home/peter/research",
              workspaceGit: true,
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "claude",
              label: "Claude Code",
              capabilities: {
                continueSession: true,
                archive: false,
                createSession: { model: "anthropic/claude-opus-4-8" },
              },
              hosts: [],
            },
          ],
        },
        "sessions.create": { key: "agent:main:claude-draft" },
      },
    });

    try {
      const model = "anthropic/claude-opus-4-8";
      await page.goto(
        `${server.baseUrl}new?agent=Research&catalog=claude&model=${encodeURIComponent("openai/gpt-5")}&label=Spoofed`,
      );

      const catalogRequest = await gateway.waitForRequest("sessions.catalog.list");
      expect(catalogRequest.params).toMatchObject({
        agentId: "research",
        catalogId: "claude",
      });
      const runtime = page.locator(".new-session-page__runtime");
      await expect.poll(() => runtime.textContent()).toContain("Claude Code");
      expect(await runtime.getAttribute("title")).toBe(model);
      expect(await page.locator('.new-session-page__trigger[title="Agent"]').count()).toBe(0);
      expect(await page.locator('[data-chat-model-select="true"]').count()).toBe(0);

      await page.locator(".new-session-page__message").fill("use Claude Code");
      await page.getByRole("button", { name: "Start thread" }).click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "research",
        message: "use Claude Code",
        catalogId: "claude",
      });
      expect(create.params).not.toHaveProperty("model");
    } finally {
      await context.close();
    }
  });

  it("navigates to a created session while canonical session refresh is pending", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:refresh-overlap-e2e";
    const listResponse = {
      count: 0,
      defaults: SESSION_LIST_DEFAULTS,
      path: "",
      sessions: [],
      ts: Date.now(),
    };
    const gateway = await installMockGateway(page, {
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "main",
              identity: { name: "Main" },
              name: "Main",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "sessions.create": { key: sessionKey },
        "sessions.list": listResponse,
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      const message = page.locator(".new-session-page__message");
      await message.waitFor({ state: "visible", timeout: 10_000 });
      const listCalls = (await gateway.getRequests("sessions.list")).length;

      await gateway.deferNext("sessions.list");
      await gateway.emitGatewayEvent("sessions.changed", {
        key: "agent:main:other-client",
        kind: "direct",
        reason: "update",
        sessionKey: "agent:main:other-client",
        updatedAt: Date.now(),
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBe(listCalls + 1);

      await message.fill("create during refresh");
      await page.getByRole("button", { name: "Start thread" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "create during refresh",
      });
      await expect
        .poll(() => new URL(page.url()).search)
        .toContain(`session=${encodeURIComponent(sessionKey)}`);

      await gateway.resolveDeferred("sessions.list", listResponse);
    } finally {
      await context.close();
    }
  });

  it("resolves a pending catalog target after reconnect without clearing the draft", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "main",
              identity: { name: "Main" },
              name: "Main",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
            {
              id: "research",
              identity: { name: "Research" },
              name: "Research",
              workspace: "/home/peter/research",
              workspaceGit: true,
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "claude",
              label: "Claude Code",
              capabilities: {
                continueSession: true,
                archive: false,
                createSession: { model: "anthropic/claude-opus-4-8" },
              },
              hosts: [],
            },
          ],
        },
        "sessions.create": { key: "agent:research:claude-reconnect" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new?agent=research`);
      await page.getByRole("heading", { name: "Research" }).waitFor();
      await gateway.setOnline(false);
      await page.locator(".sidebar-footer-bar__status").waitFor({ timeout: 10_000 });

      await page.evaluate(() => {
        history.pushState(null, "", "new?agent=research&catalog=claude");
        dispatchEvent(new PopStateEvent("popstate"));
      });

      const message = page.locator(".new-session-page__message");
      await message.fill("keep this reconnect draft");
      await expect
        .poll(() => page.locator(".new-session-page__runtime").textContent())
        .toContain("claude");
      await expect
        .poll(() => page.getByRole("button", { name: "Start thread" }).isEnabled())
        .toBe(false);
      expect(await gateway.getRequests("sessions.catalog.list")).toHaveLength(0);

      await gateway.deferNext("sessions.catalog.list");
      await gateway.setOnline(true);
      await gateway.waitForRequest("sessions.catalog.list");
      await gateway.deferNext("sessions.catalog.list");
      await gateway.rejectDeferred("sessions.catalog.list", {
        code: "UNAVAILABLE",
        message: "catalog warming up",
        retryable: true,
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
        .toBe(2);
      await gateway.resolveDeferred("sessions.catalog.list", { catalogs: [] });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length, {
          timeout: 10_000,
        })
        .toBe(3);
      await expect
        .poll(() => page.locator(".new-session-page__runtime").textContent())
        .toContain("Claude Code");
      await expect.poll(() => message.inputValue()).toBe("keep this reconnect draft");
      await expect
        .poll(() => page.getByRole("heading").first().textContent())
        .toContain("Research");

      await page.getByRole("button", { name: "Start thread" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "research",
        message: "keep this reconnect draft",
        catalogId: "claude",
      });
      expect(create.params).not.toHaveProperty("model");
      expect(create.params).not.toHaveProperty("cwd");
    } finally {
      await context.close();
    }
  });

  it("preserves a manually selected agent across a same-client reconnect", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "main",
              identity: { name: "Main" },
              name: "Main",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
            {
              id: "research",
              identity: { name: "Research" },
              name: "Research",
              workspace: "/home/peter/research",
              workspaceGit: true,
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.create": { key: "agent:research:manual-reconnect" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await page.getByRole("heading", { name: "Main" }).waitFor();
      await gateway.waitForRequest("worktrees.branches");
      const agentPicker = page.locator(".new-session-page__select--agent openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker
        .locator("wa-dropdown-item[data-agent-option]")
        .filter({ hasText: "Research" })
        .click();
      await page.getByRole("heading", { name: "Research" }).waitFor();

      const message = page.locator(".new-session-page__message");
      await message.fill("keep my selected agent");
      const agentRequestsBefore = (await gateway.getRequests("agents.list")).length;
      const branchRequestsBefore = (await gateway.getRequests("worktrees.branches")).length;

      await gateway.setOnline(false);
      await page.locator(".sidebar-footer-bar__status").waitFor({ timeout: 10_000 });
      await gateway.setMethodResponse("agents.list", {
        agents: [
          {
            id: "main",
            identity: { name: "Main" },
            name: "Main",
            workspace: WORKSPACE,
            workspaceGit: true,
          },
          {
            id: "research",
            identity: { name: "Research" },
            name: "Research",
            workspace: REFRESHED_RESEARCH_WORKSPACE,
            workspaceGit: true,
          },
        ],
        defaultId: "main",
        mainKey: "main",
        scope: "agent",
      });
      await gateway.setOnline(true);

      await expect
        .poll(async () => (await gateway.getRequests("agents.list")).length)
        .toBe(agentRequestsBefore + 1);
      await expect.poll(() => message.inputValue()).toBe("keep my selected agent");
      await expect
        .poll(() => page.getByRole("heading").first().textContent())
        .toContain("Research");
      await expect
        .poll(() =>
          page.locator("#new-session-place-trigger .new-session-page__trigger-label").textContent(),
        )
        .toBe("research-next");
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).length)
        .toBe(branchRequestsBefore + 1);
      expect((await gateway.getRequests("worktrees.branches")).at(-1)?.params).toEqual({
        repoRoot: REFRESHED_RESEARCH_WORKSPACE,
        includeRepositoryStatus: true,
      });

      const placeSelect = page.locator("wa-popover.new-session-page__place-popover");
      const placeTrigger = page.locator("#new-session-place-trigger");
      await placeTrigger.click();
      const worktreeItem = placeSelect.getByRole("button", { name: "Worktree" });
      await worktreeItem.click();
      const baseInput = page.getByLabel("Base branch");
      await expect.poll(() => baseInput.inputValue()).toBe("main");
      await page.keyboard.press("Escape");

      await gateway.deferNext("worktrees.branches");
      const branchesBeforeSameWorkspaceReconnect = (await gateway.getRequests("worktrees.branches"))
        .length;
      await gateway.setOnline(false);
      await page.locator(".sidebar-footer-bar__status").waitFor({ timeout: 10_000 });
      await gateway.setOnline(true);

      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).length)
        .toBe(branchesBeforeSameWorkspaceReconnect + 1);
      expect((await gateway.getRequests("worktrees.branches")).at(-1)?.params).toEqual({
        repoRoot: REFRESHED_RESEARCH_WORKSPACE,
        includeRepositoryStatus: true,
      });
      expect(await baseInput.inputValue()).toBe("");
      expect(await baseInput.getAttribute("placeholder")).toBe("Loading…");
      await placeTrigger.click();
      await baseInput.fill("feature-choice");
      await gateway.resolveDeferred("worktrees.branches", {
        branches: [{ kind: "local", name: "beta" }],
        defaultBranch: "beta",
        repositoryStatus: "git",
      });
      await expect.poll(() => baseInput.inputValue()).toBe("feature-choice");

      await page.getByRole("button", { name: "Start thread" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "research",
        message: "keep my selected agent",
        worktree: true,
        worktreeBaseRef: "feature-choice",
      });
      expect(create.params).not.toHaveProperty("cwd");
    } finally {
      await context.close();
    }
  });

  it("preserves a selected workspace worktree when branch rediscovery is unavailable", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.create": { key: "agent:main:worktree-unavailable" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await gateway.waitForRequest("worktrees.branches");
      const trigger = page.locator("#new-session-place-trigger");
      const place = page.locator("wa-popover.new-session-page__place-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Worktree" }).click();
      await page.keyboard.press("Escape");
      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");

      const branchRequests = (await gateway.getRequests("worktrees.branches")).length;
      await gateway.deferNext("worktrees.branches");
      await gateway.setOnline(false);
      await page.locator(".sidebar-footer-bar__status").waitFor({ timeout: 10_000 });
      await gateway.setOnline(true);
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).length)
        .toBe(branchRequests + 1);
      await gateway.rejectDeferred("worktrees.branches", {
        code: "UNAVAILABLE",
        message: "branch lookup unavailable",
      });

      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");
      await trigger.click();
      const worktree = place.getByRole("button", { name: "Worktree" });
      await expect.poll(() => worktree.getAttribute("aria-pressed")).toBe("true");
      expect(await worktree.isEnabled()).toBe(true);
      await page.keyboard.press("Escape");

      await page.locator(".new-session-page__message").fill("keep this task isolated");
      await page.getByRole("button", { name: "Start thread" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "keep this task isolated",
        worktree: true,
      });
    } finally {
      await context.close();
    }
  });

  it("clears a custom worktree when the folder becomes confirmed non-Git", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "fs.listDir": { path: WORKSPACE, home: "/home/peter", entries: [] },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.create": { key: "agent:main:custom-now-direct" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      const trigger = page.locator("#new-session-place-trigger");
      const place = page.locator("wa-popover.new-session-page__place-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Browse folders" }).click();
      await page.locator("input.new-session-page__browser-path").fill(TARGET_REPO);
      await page.getByRole("button", { name: "Use this folder" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).at(-1)?.params)
        .toEqual({ repoRoot: TARGET_REPO, includeRepositoryStatus: true });
      await trigger.click();
      await place.getByRole("button", { name: "Worktree" }).click();
      await page.keyboard.press("Escape");
      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");

      await gateway.setMethodResponse("worktrees.branches", {
        branches: [],
        repositoryStatus: "not_git",
      });
      const branchRequests = (await gateway.getRequests("worktrees.branches")).length;
      await gateway.setOnline(false);
      await page.locator(".sidebar-footer-bar__status").waitFor({ timeout: 10_000 });
      await gateway.setOnline(true);
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).length)
        .toBe(branchRequests + 1);

      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("false");
      await trigger.click();
      expect(await place.getByRole("button", { name: "Worktree" }).count()).toBe(0);
      await page.keyboard.press("Escape");
      await page.locator(".new-session-page__message").fill("continue directly");
      await page.getByRole("button", { name: "Start thread" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({ cwd: TARGET_REPO, message: "continue directly" });
      expect(create.params).not.toHaveProperty("worktree");
    } finally {
      await context.close();
    }
  });

  it("blocks a custom worktree when Git rediscovery is unavailable", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "fs.listDir": { path: WORKSPACE, home: "/home/peter", entries: [] },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      const trigger = page.locator("#new-session-place-trigger");
      const place = page.locator("wa-popover.new-session-page__place-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Browse folders" }).click();
      await page.locator("input.new-session-page__browser-path").fill(TARGET_REPO);
      await page.getByRole("button", { name: "Use this folder" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).at(-1)?.params)
        .toEqual({ repoRoot: TARGET_REPO, includeRepositoryStatus: true });
      await trigger.click();
      await place.getByRole("button", { name: "Worktree" }).click();
      await page.keyboard.press("Escape");
      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");

      await gateway.setMethodResponse("worktrees.branches", {
        branches: [],
        repositoryStatus: "unavailable",
      });
      const branchRequests = (await gateway.getRequests("worktrees.branches")).length;
      await gateway.setOnline(false);
      await page.locator(".sidebar-footer-bar__status").waitFor({ timeout: 10_000 });
      await gateway.setOnline(true);
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).length)
        .toBe(branchRequests + 1);

      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");
      await page.locator(".new-session-page__message").fill("do not run directly");
      const start = page.getByRole("button", { name: "Start thread" });
      await expect.poll(() => start.isDisabled()).toBe(true);
      await trigger.click();
      const worktree = place.getByRole("button", { name: "Worktree" });
      expect(await worktree.isDisabled()).toBe(true);
      expect(await worktree.getAttribute("title")).toBe(
        "Couldn't verify Git for this folder. Choose it again to retry.",
      );
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("blocks a custom cloud worktree when Git rediscovery is unavailable", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "environments.list": {
          environments: [],
          profiles: [{ id: "aws", providerId: "crabbox" }],
        },
        "fs.listDir": { path: WORKSPACE, home: "/home/peter", entries: [] },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const trigger = page.locator("#new-session-place-trigger");
      const place = page.locator("wa-popover.new-session-page__place-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Browse folders" }).click();
      await page.locator("input.new-session-page__browser-path").fill(TARGET_REPO);
      await page.getByRole("button", { name: "Use this folder" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).at(-1)?.params)
        .toEqual({ repoRoot: TARGET_REPO, includeRepositoryStatus: true });
      await trigger.click();
      await place.getByRole("button", { name: "Cloud · aws" }).click();
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");
      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");

      await gateway.setMethodResponse("worktrees.branches", {
        branches: [],
        repositoryStatus: "unavailable",
      });
      const branchRequests = (await gateway.getRequests("worktrees.branches")).length;
      await gateway.setOnline(false);
      await page.locator(".sidebar-footer-bar__status").waitFor({ timeout: 10_000 });
      await gateway.setOnline(true);
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).length)
        .toBe(branchRequests + 1);

      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");
      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");
      await page.locator(".new-session-page__message").fill("do not run directly");
      const start = page.getByRole("button", { name: "Start thread" });
      await expect.poll(() => start.isDisabled()).toBe(true);
      await trigger.click();
      const cloud = place.getByRole("button", { name: "Cloud · aws" });
      expect(await cloud.isDisabled()).toBe(true);
      expect(await cloud.getAttribute("title")).toBe(
        "Couldn't verify Git for this folder. Choose it again to retry.",
      );
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("validates a retained device before enabling submit after reconnect", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "main",
              identity: { name: "Main" },
              name: "Main",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "node.list": {
          nodes: [
            {
              nodeId: "old-device",
              displayName: "Old device",
              connected: true,
              commands: ["system.run", "fs.listDir"],
            },
          ],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.create": { key: "agent:main:validated-device" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await gateway.waitForRequest("node.list");
      const placeSelect = page.locator("wa-popover.new-session-page__place-popover");
      await page.locator("#new-session-place-trigger").click();
      await placeSelect.getByRole("button", { name: "Old device" }).click();
      await page.locator(".new-session-page__message").fill("use a validated device");
      const start = page.locator("button.chat-send-btn");
      const nodeRequestsBefore = (await gateway.getRequests("node.list")).length;

      await gateway.setOnline(false);
      await page.locator(".sidebar-footer-bar__status").waitFor({ timeout: 10_000 });
      await gateway.deferNext("node.list");
      await gateway.setOnline(true);
      await expect
        .poll(async () => (await gateway.getRequests("node.list")).length)
        .toBe(nodeRequestsBefore + 1);
      await expect.poll(() => start.isDisabled()).toBe(true);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);

      await gateway.resolveDeferred("node.list", { nodes: [] });
      await expect.poll(() => start.isEnabled()).toBe(true);
      await start.click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).not.toHaveProperty("execNode");
      expect(create.params).not.toHaveProperty("cwd");
    } finally {
      await context.close();
    }
  });

  it("rediscovers Gateway-owned draft state when the app replaces its client", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "main",
              identity: { name: "Original agent" },
              name: "Original agent",
              workspace: SOURCE_REPO,
              workspaceGit: true,
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "node.list": {
          nodes: [
            {
              nodeId: "old-device",
              displayName: "Old device",
              connected: true,
              commands: ["system.run", "fs.listDir"],
            },
          ],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "alpha" }],
          defaultBranch: "alpha",
          repositoryStatus: "git",
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await page.getByRole("heading", { name: "Original agent" }).waitFor();
      await gateway.waitForRequest("node.list");
      await gateway.waitForRequest("worktrees.branches");

      const message = page.locator(".new-session-page__message");
      const placeSelect = page.locator("wa-popover.new-session-page__place-popover");
      const placeTrigger = page.locator("#new-session-place-trigger");
      await message.fill("preserve this replacement draft");
      await placeTrigger.click();
      await placeSelect.getByRole("button", { name: "Old device" }).click();

      // Keep an old-client browser request in flight. Replacement must close
      // its menu and prevent its eventual completion from reviving old state.
      await gateway.deferNext("fs.listDir");
      await placeTrigger.click();
      await placeSelect.getByRole("button", { name: "Browse folders" }).click();
      await gateway.waitForRequest("fs.listDir");

      await gateway.setMethodResponse("agents.list", {
        agents: [
          {
            id: "main",
            identity: { name: "Replacement agent" },
            name: "Replacement agent",
            workspace: TARGET_REPO,
            workspaceGit: true,
          },
        ],
        defaultId: "main",
        mainKey: "main",
        scope: "agent",
      });
      await gateway.setMethodResponse("node.list", {
        nodes: [
          {
            nodeId: "new-device",
            displayName: "New device",
            connected: true,
            commands: ["system.run", "fs.listDir"],
          },
        ],
      });
      await gateway.setMethodResponse("worktrees.branches", {
        branches: [{ kind: "local", name: "beta" }],
        defaultBranch: "beta",
        repositoryStatus: "git",
      });
      const socketsBefore = await gateway.getSocketCount();
      const nodesBefore = (await gateway.getRequests("node.list")).length;
      const branchesBefore = (await gateway.getRequests("worktrees.branches")).length;

      await replaceGatewayClient(page);

      await expect.poll(() => gateway.getSocketCount()).toBe(socketsBefore + 1);
      await expect
        .poll(async () => (await gateway.getRequests("node.list")).length)
        .toBe(nodesBefore + 1);
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).length)
        .toBe(branchesBefore + 1);
      await page.getByRole("heading", { name: "Replacement agent" }).waitFor();
      await expect.poll(() => message.inputValue()).toBe("preserve this replacement draft");
      await expect
        .poll(() =>
          placeSelect.evaluate((element) => (element as HTMLElement & { open: boolean }).open),
        )
        .toBe(false);
      await expect
        .poll(() => placeTrigger.locator(".new-session-page__trigger-label").textContent())
        .toBe("target-repo · Gateway · local");

      const branchRequests = await gateway.getRequests("worktrees.branches");
      expect(branchRequests.at(-1)?.params).toEqual({
        repoRoot: TARGET_REPO,
        includeRepositoryStatus: true,
      });
      await placeTrigger.click();
      await placeSelect.getByRole("button", { name: "New device" }).waitFor();
      expect(await placeSelect.getByRole("button", { name: "Old device" }).count()).toBe(0);
      await placeSelect.getByRole("button", { name: "Worktree" }).click();
      await expect.poll(() => page.getByLabel("Base branch").inputValue()).toBe("beta");
      await page.keyboard.press("Escape");

      await gateway.resolveDeferred("fs.listDir", {
        path: "/stale-device-path",
        home: "/stale-device-path",
        entries: [],
      });
      await expect
        .poll(() =>
          placeSelect.evaluate((element) => (element as HTMLElement & { open: boolean }).open),
        )
        .toBe(false);
      await expect.poll(() => message.inputValue()).toBe("preserve this replacement draft");
    } finally {
      await context.close();
    }
  });

  for (const reconnectKind of ["same-client reconnect", "client replacement"] as const) {
    it(`marks a pending creation outcome unknown after ${reconnectKind}`, async () => {
      const context = await browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });
      const page = await context.newPage();
      const sessionKey = `agent:main:unknown-${reconnectKind.replaceAll(" ", "-")}`;
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "agents.list": {
            agents: [
              {
                id: "main",
                identity: { name: "Original agent" },
                name: "Original agent",
                workspace: SOURCE_REPO,
                workspaceGit: true,
              },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "worktrees.branches": {
            branches: [{ kind: "local", name: "main" }],
            defaultBranch: "main",
            repositoryStatus: "git",
          },
          "sessions.create": { key: sessionKey },
        },
      });

      try {
        await page.goto(`${server.baseUrl}new`);
        await page.getByRole("heading", { name: "Original agent" }).waitFor();
        const message = page.locator(".new-session-page__message");
        const start = page.locator("button.chat-send-btn");
        await message.fill("retry this draft after reconnect");
        await gateway.deferNext("sessions.create");
        await start.click();
        await gateway.waitForRequest("sessions.create");
        await expect.poll(() => start.isDisabled()).toBe(true);

        if (reconnectKind === "client replacement") {
          await gateway.setMethodResponse("agents.list", {
            agents: [
              {
                id: "main",
                identity: { name: "Replacement agent" },
                name: "Replacement agent",
                workspace: TARGET_REPO,
                workspaceGit: true,
              },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          });
          const socketsBefore = await gateway.getSocketCount();
          await replaceGatewayClient(page);
          await expect.poll(() => gateway.getSocketCount()).toBe(socketsBefore + 1);
          await page.getByRole("heading", { name: "Replacement agent" }).waitFor();
        } else {
          const agentRequestsBefore = (await gateway.getRequests("agents.list")).length;
          await gateway.setOnline(false);
          await page.locator(".sidebar-footer-bar__status").waitFor({ timeout: 10_000 });
          await gateway.setOnline(true);
          await expect
            .poll(async () => (await gateway.getRequests("agents.list")).length)
            .toBe(agentRequestsBefore + 1);
        }
        await expect.poll(() => message.inputValue()).toBe("retry this draft after reconnect");
        await expect.poll(() => message.isEnabled()).toBe(true);
        await expect.poll(() => start.isDisabled()).toBe(true);
        await page
          .getByText(
            "The Gateway changed while this thread was starting. Check recent threads before starting this task again.",
          )
          .waitFor();
        expect(new URL(page.url()).searchParams.get("session")).toBeNull();
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      } finally {
        await context.close();
      }
    });
  }

  it("resets agent-derived workspace state when retargeted to a catalog", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "main",
              identity: { name: "Main" },
              name: "Main",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
            {
              id: "research",
              identity: { name: "Research" },
              name: "Research",
              workspace: "/home/peter/research",
              workspaceGit: true,
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "claude",
              label: "Claude Code",
              capabilities: {
                continueSession: true,
                archive: false,
                createSession: { model: "anthropic/claude-opus-4-8" },
              },
              hosts: [],
            },
          ],
        },
        "sessions.create": { key: "agent:main:claude-retarget" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new?agent=research`);
      const folderLabel = page.locator(
        "#new-session-place-trigger .new-session-page__trigger-label",
      );
      await expect.poll(() => folderLabel.textContent()).toBe("research");

      await page.evaluate(() => {
        history.pushState(null, "", "new?agent=main&catalog=claude");
        dispatchEvent(new PopStateEvent("popstate"));
      });

      await expect
        .poll(() => page.locator(".new-session-page__runtime").textContent())
        .toContain("Claude Code");
      await expect.poll(() => folderLabel.textContent()).toBe("openclaw");
      await page.locator(".new-session-page__message").fill("retarget this draft");
      await page.getByRole("button", { name: "Start thread" }).click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "retarget this draft",
        catalogId: "claude",
      });
      expect(create.params).not.toHaveProperty("model");
      expect(create.params).not.toHaveProperty("cwd");
    } finally {
      await context.close();
    }
  });

  it("locks the submitted draft until creation settles and restores it after failure", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:locked-new-session-draft";
    const submittedMessage = "keep this submitted draft atomic";
    const gateway = await installMockGateway(page, {
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "main",
              identity: { name: "Main" },
              name: "Main",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.list": {
          count: 0,
          defaults: SESSION_LIST_DEFAULTS,
          path: "",
          sessions: [],
          ts: Date.now(),
        },
        "sessions.create": { key: sessionKey },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await gateway.deferNext("sessions.create");

      const draft = page.locator(".new-session-page__scroll");
      const message = page.locator(".new-session-page__message");
      const placeSelect = page.locator("wa-popover.new-session-page__place-popover");
      const placeSummary = page.locator("#new-session-place-trigger");

      await message.fill(submittedMessage);
      await placeSummary.click();
      expect(await placeSelect.getAttribute("open")).not.toBeNull();
      await page.getByRole("button", { name: "Start thread" }).click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({ message: submittedMessage });
      await expect.poll(() => message.isDisabled()).toBe(true);
      expect(await draft.getAttribute("inert")).not.toBeNull();
      expect(await draft.getAttribute("aria-busy")).toBe("true");
      expect(await placeSelect.getAttribute("open")).toBeNull();
      expect(await placeSummary.isDisabled()).toBe(true);

      await expect(
        message.fill("silently discarded late edit", { timeout: 250 }),
      ).rejects.toThrow();
      await placeSummary.click({ force: true });
      await page.locator(".agent-chat__suggestion").first().click({ force: true });
      expect(await placeSelect.getAttribute("open")).toBeNull();
      expect(await message.inputValue()).toBe(submittedMessage);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);

      await gateway.rejectDeferred("sessions.create", {
        code: "UNAVAILABLE",
        message: "session creation unavailable",
      });
      await expect.poll(() => message.isDisabled()).toBe(false);
      expect(await draft.getAttribute("inert")).toBeNull();
      expect(await draft.getAttribute("aria-busy")).toBe("false");
      expect(await message.inputValue()).toBe(submittedMessage);
      expect(await placeSummary.isDisabled()).toBe(false);

      await page.getByRole("button", { name: "Start thread" }).click();
      await expect.poll(async () => (await gateway.getRequests("sessions.create")).length).toBe(2);
      const retry = (await gateway.getRequests("sessions.create")).at(-1);
      expect(retry?.params).toMatchObject({ message: submittedMessage });
      await page.waitForURL((url) => url.searchParams.get("session") === sessionKey, {
        timeout: 30_000,
      });
    } finally {
      await context.close();
    }
  });

  it("keeps a rejected first message visible and retryable after reload", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:rejected-first-message";
    const message = "keep this rejected first message";
    const runError = "send blocked by session policy";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "main",
              identity: { name: "Main" },
              name: "Main",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.list": {
          count: 1,
          defaults: SESSION_LIST_DEFAULTS,
          path: "",
          sessions: [
            {
              hasActiveRun: false,
              key: sessionKey,
              kind: "direct",
              status: "done",
              updatedAt: Date.now(),
            },
          ],
          ts: Date.now(),
        },
        "sessions.create": {
          key: sessionKey,
          runStarted: false,
          runError: { code: "INVALID_REQUEST", message: runError },
        },
        "chat.history": {
          messages: [],
          sessionId: "rejected-first-message",
          sessionInfo: { hasActiveRun: false, key: sessionKey, status: "done" },
        },
        "chat.send": { runId: "retry-run", status: "started" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      const composer = page.locator(".new-session-page__message");
      await composer.fill(message);
      await pastePng(composer);
      await page.getByRole("button", { name: "Start thread" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        message,
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
      });

      await page.waitForURL((url) => url.searchParams.get("session") === sessionKey, {
        timeout: 30_000,
      });
      await expect
        .poll(() => page.locator(".chat-queue__text").allInnerTexts(), { timeout: 30_000 })
        .toContain(message);
      await expect
        .poll(() => page.locator(".chat-queue__error").allInnerTexts(), { timeout: 30_000 })
        .toContain(runError);

      await page.reload();
      await expect
        .poll(() => page.locator(".chat-queue__text").allInnerTexts(), { timeout: 30_000 })
        .toContain(message);
      await expect
        .poll(() => page.locator(".chat-queue__error").allInnerTexts(), { timeout: 30_000 })
        .toContain(runError);

      await page.getByRole("button", { name: "Retry queued message" }).click();
      const retry = await gateway.waitForRequest("chat.send");
      expect(retry.params).toMatchObject({
        sessionKey,
        message,
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("adopts a created session when rejected-turn persistence exceeds browser storage", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const setItem = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem")
        ?.value as Storage["setItem"];
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key.startsWith("openclaw.control.chatComposer.v2:")) {
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        }
        return setItem.call(this, key, value);
      };
    });
    const sessionKey = "agent:main:storage-failed-initial-turn";
    const message = "retry this in the session that already exists";
    const runError = "initial send rejected";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.create": {
          key: sessionKey,
          runStarted: false,
          runError: { code: "INVALID_REQUEST", message: runError },
        },
        "chat.history": {
          messages: [],
          sessionId: "storage-failed-initial-turn",
          sessionInfo: { hasActiveRun: false, key: sessionKey, status: "done" },
        },
        "chat.send": { runId: "storage-failure-retry", status: "started" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      const composer = page.locator(".new-session-page__message");
      await composer.fill(message);
      await pastePng(composer);
      await page.getByRole("button", { name: "Start thread" }).click();

      await page.waitForURL((url) => url.searchParams.get("session") === sessionKey, {
        timeout: 30_000,
      });
      await expect
        .poll(() => page.locator(".chat-queue__text").allInnerTexts(), { timeout: 30_000 })
        .toContain(message);
      await expect
        .poll(() => page.locator(".chat-queue__error").allInnerTexts(), { timeout: 30_000 })
        .toContain(runError);
      await page.getByRole("button", { name: "Retry queued message" }).click();
      const retry = await gateway.waitForRequest("chat.send");
      expect(retry.params).toMatchObject({
        sessionKey,
        message,
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  it("browses capable nodes and accepts manual paths for exec-only nodes", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "main",
              identity: { name: "Main" },
              name: "Main",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "node.list": {
          nodes: [
            {
              nodeId: "macbook",
              displayName: "MacBook",
              connected: true,
              commands: ["system.run", "fs.listDir"],
            },
            {
              nodeId: "old-node",
              displayName: "Old node",
              connected: true,
              commands: ["system.run"],
            },
            {
              nodeId: "offline-node",
              displayName: "Offline node",
              connected: false,
              commands: ["system.run", "fs.listDir"],
            },
          ],
        },
        "fs.listDir": {
          cases: [
            {
              match: { nodeId: "macbook", path: NODE_UNC },
              response: {
                path: NODE_UNC,
                parent: "\\\\server\\share",
                home: "C:\\Users\\peter",
                entries: [],
              },
            },
            {
              match: { nodeId: "macbook", path: NODE_PICKED },
              response: {
                path: NODE_PICKED,
                parent: NODE_HOME,
                home: NODE_HOME,
                entries: [],
              },
            },
            {
              match: { nodeId: "macbook" },
              response: {
                path: NODE_HOME,
                home: NODE_HOME,
                entries: [{ name: "Projects", path: NODE_PICKED }],
              },
            },
          ],
        },
        "sessions.create": { key: "agent:main:node-draft-e2e" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await page.locator(".new-session-page__message").waitFor();
      const placeSelect = page.locator("wa-popover.new-session-page__place-popover");
      const placeTrigger = page.locator("#new-session-place-trigger");
      const placeLabel = placeTrigger.locator(".new-session-page__trigger-label");
      const browserEntries = page.locator(".new-session-page__browser-list");

      // Pick the node from Places.
      await placeTrigger.click();
      await placeSelect.getByRole("button", { name: "MacBook" }).click();
      await expect.poll(() => placeLabel.textContent()).toBe("Agent workspace · MacBook");
      // Node sessions cannot use managed worktrees, so the menu drops the item.
      await placeTrigger.click();
      expect(await placeSelect.getByRole("button", { name: "Worktree" }).count()).toBe(0);
      await page.keyboard.press("Escape");

      // Manual path entry in the browser head preserves UNC paths; these
      // cannot be rediscovered by starting at the node home directory.
      await placeTrigger.click();
      await placeSelect.getByRole("button", { name: "Browse folders" }).click();
      const pathInput = page.locator("input.new-session-page__browser-path");
      await expect.poll(() => pathInput.inputValue()).toBe(NODE_HOME);
      await pathInput.fill(NODE_UNC);
      await pathInput.press("Enter");
      await expect.poll(() => pathInput.inputValue()).toBe(NODE_UNC);
      // Escape returns to the picker root without applying or closing it.
      await page.keyboard.press("Escape");
      await expect
        .poll(() =>
          placeSelect.evaluate((element) => (element as HTMLElement & { open: boolean }).open),
        )
        .toBe(true);
      await placeSelect.getByText("Places", { exact: true }).waitFor();

      // Destination selection stays in Places; browsing is fixed to the current target.
      await placeSelect.getByRole("button", { name: "Gateway · local" }).click();
      await expect.poll(() => placeLabel.textContent()).toBe("openclaw · Gateway · local");
      await placeTrigger.click();
      expect(await placeSelect.getByRole("button", { name: "Offline node" }).count()).toBe(0);
      await placeSelect.getByRole("button", { name: "MacBook" }).click();
      await placeTrigger.click();
      await placeSelect.getByRole("button", { name: "Browse folders" }).click();
      await browserEntries.getByRole("button", { name: "Projects" }).click();
      await page.getByRole("button", { name: "Use this folder" }).click();

      // Using a node folder retargets the draft to that node.
      await expect.poll(() => placeLabel.textContent()).toBe("Projects · MacBook");

      // Clearing the path applies the node's default directory (empty folder),
      // the state the replaced clearable folder textbox could express.
      await placeTrigger.click();
      await placeSelect.getByRole("button", { name: "Browse folders" }).click();
      await expect.poll(() => pathInput.inputValue()).toBe(NODE_PICKED);
      await pathInput.fill("");
      await page.getByRole("button", { name: "Use this folder" }).click();
      await expect.poll(() => placeLabel.textContent()).toBe("Agent workspace · MacBook");

      // Browse back to the custom folder, then retarget to the exec-only node
      // with a manual absolute path for the final create assertion.
      await placeTrigger.click();
      await placeSelect.getByRole("button", { name: "Browse folders" }).click();
      await browserEntries.getByRole("button", { name: "Projects" }).click();
      await page.getByRole("button", { name: "Use this folder" }).click();
      await expect.poll(() => placeLabel.textContent()).toBe("Projects · MacBook");

      await placeTrigger.click();
      await placeSelect.getByRole("button", { name: "Old node" }).click();
      await placeTrigger.click();
      await placeSelect.getByRole("button", { name: "Browse folders" }).click();
      await expect.poll(() => pathInput.inputValue()).toBe("");
      await pathInput.fill(EXEC_ONLY_PICKED);
      await pathInput.press("Enter");
      expect(
        (await gateway.getRequests("fs.listDir")).filter(
          (request) => (request.params as { nodeId?: string } | undefined)?.nodeId === "old-node",
        ),
      ).toHaveLength(0);
      await page.getByRole("button", { name: "Use this folder" }).click();
      await expect.poll(() => placeLabel.textContent()).toBe("repo · Old node");

      await page.locator(".new-session-page__message").fill("inspect the remote checkout");
      await page.getByRole("button", { name: "Start thread" }).click();
      const createRequest = await gateway.waitForRequest("sessions.create");
      expect(createRequest.params).toMatchObject({
        agentId: "main",
        message: "inspect the remote checkout",
        execNode: "old-node",
        cwd: EXEC_ONLY_PICKED,
      });
      expect(createRequest.params).not.toHaveProperty("worktree");
    } finally {
      await context.close();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
