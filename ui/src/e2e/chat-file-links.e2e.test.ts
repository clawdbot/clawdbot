// Real-browser proof for opening workspace files from chat links and the workspace browser.
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { beforeEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
let artifactDir: string;
beforeEach(() => {
  artifactDir = createControlUiE2eArtifactDir("chat-file-links");
});

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI chat file links", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("shows the Review panel before a clicked file finishes loading", async () => {
    const context = await browser.newContext({
      recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } },
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
    try {
      const file = {
        root: "/workspace",
        sessionKey: "agent:main:main",
        file: {
          content: "export const loaded = true;\n",
          kind: "read",
          missing: false,
          name: "slow.ts",
          path: "src/slow.ts",
          workspacePath: "src/slow.ts",
        },
      };
      const gateway = await installMockGateway(page, {
        deferredMethods: ["sessions.files.get"],
        historyMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Review `src/slow.ts`." }],
            timestamp: 1,
          },
        ],
        methodResponses: { "sessions.files.get": file },
      });
      await page.goto(`${server.baseUrl}chat`);

      await page.locator('a.markdown-file-link[data-file-path="src/slow.ts"]').click();
      await gateway.waitForRequest("sessions.files.get");

      await page.locator(".side-panel").waitFor({ state: "visible" });
      expect(await page.locator(".sidebar-file-view").count()).toBe(0);
      await page.screenshot({ path: path.join(artifactDir, "latency-panel-before-file.png") });

      await gateway.resolveDeferred("sessions.files.get");
      await page.locator(".sidebar-file-view").waitFor({ state: "visible" });
      await expect
        .poll(() => page.locator(".cm-content").textContent())
        .toContain("export const loaded = true;");
      await page.screenshot({ path: path.join(artifactDir, "latency-file-loaded.png") });
    } finally {
      await context.close();
    }
  });

  it("opens the selected file from chat and the workspace root", async () => {
    const context = await browser.newContext({
      recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } },
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
    try {
      const gateway = await installMockGateway(page, {
        historyMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Review `README.md:2`." }],
            timestamp: 1,
          },
        ],
        methodResponses: {
          "sessions.files.get": {
            cases: [
              {
                match: { path: "README.md" },
                response: {
                  root: "/workspace",
                  file: {
                    content: "# Project\n\nNested workspace notes.\n",
                    kind: "read",
                    missing: false,
                    name: "README.md",
                    path: "README.md",
                    workspacePath: "packages/app/README.md",
                  },
                },
              },
              {
                match: { path: "/workspace/packages/app/README.md" },
                response: {
                  root: "/workspace",
                  file: {
                    content: "# Project\n\nNested workspace notes.\n",
                    kind: "read",
                    missing: false,
                    name: "README.md",
                    path: "packages/app/README.md",
                    workspacePath: "packages/app/README.md",
                  },
                },
              },
            ],
          },
          "sessions.files.list": {
            root: "/workspace",
            sessionKey: "agent:main:main",
            files: [],
            browser: {
              entries: [
                {
                  kind: "file",
                  name: "README.md",
                  path: "packages/app/README.md",
                  size: 42,
                },
              ],
              path: "",
            },
          },
        },
      });

      await page.goto(`${server.baseUrl}chat`);
      const chatLink = page.locator('a.markdown-file-link[data-file-path="README.md"]');
      await chatLink.waitFor({ state: "visible" });
      await page.screenshot({ path: path.join(artifactDir, "01-chat-file-link.png") });
      await chatLink.click();

      const fileView = page.locator(".sidebar-file-view");
      await fileView.waitFor({ state: "visible" });
      expect(await fileView.locator(".file-view__line--target").getAttribute("data-line")).toBe(
        "2",
      );
      expect((await gateway.getRequests("sessions.files.get"))[0]?.params).toMatchObject({
        path: "README.md",
      });
      await page.screenshot({ path: path.join(artifactDir, "02-chat-file-preview.png") });

      await fileView.getByRole("button", { name: "Show in Files" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.list"))[0]?.params)
        .toMatchObject({ path: "packages/app" });
      const browserRow = page
        .locator(".chat-workspace-rail__browser .chat-workspace-rail__file")
        .filter({ hasText: "README.md" });
      await browserRow.locator(".chat-workspace-rail__file-open").click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.get"))[1]?.params)
        .toMatchObject({ path: "/workspace/packages/app/README.md" });
      await page.screenshot({ path: path.join(artifactDir, "03-workspace-file-preview.png") });
    } finally {
      await context.close();
    }
  });

  it("previews text and browser-safe images while falling back for unsupported binaries", async () => {
    const png = fs.readFileSync(path.resolve(process.cwd(), "ui/public/apple-touch-icon.png"));
    expect(png.byteLength).toBeLessThan(256 * 1024);
    const pngBase64 = png.toString("base64");
    const responses = {
      "/workspace/notes.txt": {
        root: "/workspace",
        sessionKey: "agent:main:main",
        file: {
          content: "Exact-head workspace preview proof.\n",
          contentEncoding: "utf8",
          hash: "a".repeat(64),
          kind: "read",
          mimeType: "text/plain",
          missing: false,
          name: "notes.txt",
          path: "notes.txt",
          previewKind: "text",
          size: 36,
          workspacePath: "notes.txt",
        },
      },
      "/workspace/openclaw.png": {
        root: "/workspace",
        sessionKey: "agent:main:main",
        file: {
          content: pngBase64,
          contentEncoding: "base64",
          kind: "read",
          mimeType: "image/png",
          missing: false,
          name: "openclaw.png",
          path: "openclaw.png",
          previewKind: "image",
          size: png.byteLength,
          workspacePath: "openclaw.png",
        },
      },
      "/workspace/unsupported-binary.bmp": {
        root: "/workspace",
        sessionKey: "agent:main:main",
        file: {
          kind: "read",
          mimeType: "image/bmp",
          missing: false,
          name: "unsupported-binary.bmp",
          path: "unsupported-binary.bmp",
          previewKind: "unsupported",
          size: 4096,
          workspacePath: "unsupported-binary.bmp",
        },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const context = await browser.newContext({
      recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } },
      viewport: { height: 900, width: 1280 },
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.files.get": {
            cases: Object.entries(responses).map(([requestPath, response]) => ({
              match: { path: requestPath },
              response,
            })),
          },
          "sessions.files.list": {
            browser: {
              entries: Object.keys(responses).map((requestPath) => {
                const filePath = requestPath.slice("/workspace/".length);
                return { kind: "file", name: filePath, path: filePath };
              }),
              path: "",
            },
            files: [],
            root: "/workspace",
            sessionKey: "agent:main:main",
          },
        },
      });
      const openPreview = async (filePath: string) => {
        const fileRow = page
          .locator(".chat-workspace-rail__browser .chat-workspace-rail__file")
          .filter({ hasText: filePath });
        await fileRow.locator(".chat-workspace-rail__file-open").click();
      };
      const closePreview = async () => {
        await page.getByRole("button", { name: "Close Review" }).click();
        await page.locator("openclaw-chat-detail-panel").waitFor({ state: "detached" });
      };

      await page.goto(`${server.baseUrl}chat`);
      await openChatSidePanelType(page, "Files");
      await page.getByRole("complementary", { name: "Session workspace" }).waitFor();

      await openPreview("notes.txt");
      await page.locator(".sidebar-file-view").waitFor({ state: "visible" });
      expect(await page.locator(".cm-content").textContent()).toContain(
        "Exact-head workspace preview proof.",
      );
      await page.screenshot({ path: path.join(artifactDir, "04-text-preview.png") });
      await closePreview();

      await openPreview("openclaw.png");
      const image = page.locator('.chat-tool-card__preview[data-kind="image"] img');
      await image.waitFor({ state: "visible" });
      expect(await image.getAttribute("src")).toBe(`data:image/png;base64,${pngBase64}`);
      await expect
        .poll(() =>
          image.evaluate((element) => {
            const img = element as HTMLImageElement;
            return img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
          }),
        )
        .toBe(true);
      await page.screenshot({ path: path.join(artifactDir, "05-png-preview.png") });
      await closePreview();

      await openPreview("unsupported-binary.bmp");
      const fallback = page.locator(".sidebar-markdown-shell");
      await fallback.waitFor({ state: "visible" });
      const fallbackText = await fallback.textContent();
      expect(fallbackText).toContain("This file is not previewable inline.");
      expect(fallbackText).toContain("unsupported-binary.bmp");
      expect(fallbackText).toContain("image/bmp");
      await page.screenshot({ path: path.join(artifactDir, "06-bmp-fallback.png") });

      expect(
        (await gateway.getRequests("sessions.files.get")).map((request) => request.params),
      ).toEqual([
        { agentId: "main", path: "/workspace/notes.txt", sessionKey: "agent:main:main" },
        { agentId: "main", path: "/workspace/openclaw.png", sessionKey: "agent:main:main" },
        {
          agentId: "main",
          path: "/workspace/unsupported-binary.bmp",
          sessionKey: "agent:main:main",
        },
      ]);
    } finally {
      await context.close();
    }
  });
});
