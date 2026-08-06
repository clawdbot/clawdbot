import { chromium, type Browser } from "playwright";
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
const expectUploadSurface = process.env.OPENCLAW_TERMINAL_UPLOAD_EXPECT_PRESENT !== "0";
const screenshotPath = process.env.OPENCLAW_TERMINAL_UPLOAD_SCREENSHOT?.trim();
const progressScreenshotPath = process.env.OPENCLAW_TERMINAL_UPLOAD_PROGRESS_SCREENSHOT?.trim();
const errorScreenshotPath = process.env.OPENCLAW_TERMINAL_UPLOAD_ERROR_SCREENSHOT?.trim();
const videoDir = process.env.OPENCLAW_TERMINAL_UPLOAD_VIDEO_DIR?.trim();

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI terminal file upload", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("uploads picked and dropped files, then pastes staged paths without Enter", async () => {
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1280, height: 800 },
      ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } } : {}),
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      (
        window as Window & {
          ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: { gatewayUrl: string; token: string };
        }
      )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
        gatewayUrl: "ws://gateway.example.test",
        token: "test",
      };
    });
    const stagedPath = "/tmp/openclaw-terminal-upload/sample file.pdf";
    const stagedNotesPath = "/tmp/openclaw-terminal-upload/notes.txt";
    const stagedDropPath = "/tmp/openclaw-terminal-upload/dropped.png";
    const gateway = await installMockGateway(page, {
      deferredMethods: ["connect"],
      featureMethods: ["terminal.open", "terminal.upload"],
      methodResponses: {
        "terminal.list": { sessions: [] },
        "terminal.open": {
          agentId: "main",
          confined: false,
          cwd: "/workspace",
          sessionId: "terminal-upload-e2e",
          shell: "/bin/bash",
        },
        "terminal.upload": { path: stagedPath, size: 4 },
      },
      terminalEnabled: true,
    });

    try {
      await page.goto(`${server.baseUrl}?view=terminal`);
      await gateway.waitForRequest("connect");
      await gateway.resolveDeferred("connect");
      await gateway.waitForRequest("terminal.open");

      const addFiles = page.locator("button.tp-upload");
      if (!expectUploadSurface) {
        expect(await addFiles.count()).toBe(0);
        if (screenshotPath) {
          await page.screenshot({ path: screenshotPath });
        }
        return;
      }

      await addFiles.waitFor({ state: "visible" });
      expect(await addFiles.isEnabled()).toBe(true);
      if (screenshotPath) {
        await page.screenshot({ path: screenshotPath });
      }

      await gateway.deferNext("terminal.upload");
      await page.locator("input.tp-file-input").setInputFiles([
        { name: "sample file.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") },
        { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("note") },
      ]);
      await expect
        .poll(async () => (await gateway.getRequests("terminal.upload")).length, {
          timeout: 10_000,
        })
        .toBe(1);
      await page.getByText("Uploading 1 of 2").waitFor();
      const progress = page.locator(".tp-upload-progress");
      await expect.poll(async () => await progress.getAttribute("aria-valuenow")).toBe("0");
      await expect.poll(async () => await progress.getAttribute("aria-valuemax")).toBe("2");
      if (progressScreenshotPath) {
        await page.screenshot({ path: progressScreenshotPath });
      }

      await gateway.deferNext("terminal.upload");
      await gateway.resolveDeferred("terminal.upload", { path: stagedPath, size: 4 });
      await expect
        .poll(async () => (await gateway.getRequests("terminal.upload")).length, {
          timeout: 10_000,
        })
        .toBe(2);
      await page.getByText("Uploading 2 of 2").waitFor();
      await expect.poll(async () => await progress.getAttribute("aria-valuenow")).toBe("1");
      await gateway.rejectDeferred("terminal.upload", {
        code: "UNAVAILABLE",
        message: "paired node went offline",
      });
      await page.getByText("Upload failed").waitFor();
      await page.getByText("paired node went offline").waitFor();
      expect(await page.getByRole("button", { name: "Retry" }).isVisible()).toBe(true);
      expect((await gateway.getRequests("terminal.input")).length).toBe(0);
      if (errorScreenshotPath) {
        await page.screenshot({ path: errorScreenshotPath });
      }

      await gateway.setMethodResponse("terminal.upload", { path: stagedNotesPath, size: 4 });
      await page.getByRole("button", { name: "Retry" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("terminal.upload")).length, {
          timeout: 10_000,
        })
        .toBe(3);
      const pickedUploads = await gateway.getRequests("terminal.upload");
      expect(pickedUploads.slice(0, 3).map((request) => request.params)).toEqual([
        {
          sessionId: "terminal-upload-e2e",
          name: "sample file.pdf",
          contentBase64: "JVBERg==",
        },
        {
          sessionId: "terminal-upload-e2e",
          name: "notes.txt",
          contentBase64: "bm90ZQ==",
        },
        {
          sessionId: "terminal-upload-e2e",
          name: "notes.txt",
          contentBase64: "bm90ZQ==",
        },
      ]);
      await expect
        .poll(async () => (await gateway.getRequests("terminal.input")).length, {
          timeout: 10_000,
        })
        .toBe(1);
      const pickedInput = (await gateway.getRequests("terminal.input"))[0]?.params as {
        data?: string;
      };
      expect(pickedInput.data).toContain("'/tmp/openclaw-terminal-upload/sample file.pdf'");
      expect(pickedInput.data).toContain("/tmp/openclaw-terminal-upload/notes.txt");
      expect(pickedInput.data).not.toMatch(/[\r\n]/);

      await gateway.setMethodResponse("terminal.upload", { path: stagedDropPath, size: 3 });
      await page.locator("wa-tab-panel.tp-viewport").evaluate((target) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array([1, 2, 3])], "dropped.png"));
        target.dispatchEvent(
          new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
        target.dispatchEvent(
          new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
      });
      await expect
        .poll(async () => (await gateway.getRequests("terminal.upload")).length, {
          timeout: 10_000,
        })
        .toBe(4);
      const droppedUpload = (await gateway.getRequests("terminal.upload")).at(-1);
      expect(droppedUpload?.params).toEqual({
        sessionId: "terminal-upload-e2e",
        name: "dropped.png",
        contentBase64: "AQID",
      });
      await expect
        .poll(async () => (await gateway.getRequests("terminal.input")).length, {
          timeout: 10_000,
        })
        .toBe(2);
      const droppedInput = (await gateway.getRequests("terminal.input")).at(-1)?.params as {
        data?: string;
      };
      expect(droppedInput.data).toContain("/tmp/openclaw-terminal-upload/dropped.png");
      expect(droppedInput.data).not.toMatch(/[\r\n]/);

      await gateway.deferNext("terminal.upload");
      await page.locator("input.tp-file-input").setInputFiles({
        name: "cancelled.zip",
        mimeType: "application/zip",
        buffer: Buffer.from("zip"),
      });
      await expect
        .poll(async () => (await gateway.getRequests("terminal.upload")).length, {
          timeout: 10_000,
        })
        .toBe(5);
      await page.getByText("Uploading 1 of 1").waitFor();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect.poll(async () => await page.locator(".tp-upload-card").count()).toBe(0);
      await gateway.resolveDeferred("terminal.upload", {
        path: "/tmp/openclaw-terminal-upload/cancelled.zip",
        size: 3,
      });
      await page.waitForTimeout(100);
      expect((await gateway.getRequests("terminal.input")).length).toBe(2);
    } finally {
      await context.close();
    }
  });
});
