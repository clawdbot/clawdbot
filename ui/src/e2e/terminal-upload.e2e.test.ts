import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI terminal file upload",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const expectUploadSurface = process.env.OPENCLAW_TERMINAL_UPLOAD_EXPECT_PRESENT !== "0";
const requestedScreenshotPath = process.env.OPENCLAW_TERMINAL_UPLOAD_SCREENSHOT?.trim();
const requestedProgressScreenshotPath =
  process.env.OPENCLAW_TERMINAL_UPLOAD_PROGRESS_SCREENSHOT?.trim();
const requestedErrorScreenshotPath = process.env.OPENCLAW_TERMINAL_UPLOAD_ERROR_SCREENSHOT?.trim();
const requestedVideoDir = process.env.OPENCLAW_TERMINAL_UPLOAD_VIDEO_DIR?.trim();

suite.define(() => {
  it("uploads picked and dropped files, then pastes staged paths without Enter", async () => {
    // Independent requested parents stay independent; captures under one parent share this attempt.
    const directories = new Map<string, string>();
    const directoryFor = (parent: string) => {
      const resolved = path.resolve(parent);
      let directory = directories.get(resolved);
      if (!directory) {
        directory = createControlUiE2eArtifactDir("terminal-upload", resolved);
        directories.set(resolved, directory);
      }
      return directory;
    };
    const screenshotFor = (requested: string | undefined, stage: string) => {
      if (!requested) {
        return undefined;
      }
      const output = path.join(
        directoryFor(path.dirname(requested)),
        stage,
        path.basename(requested),
      );
      console.info(`[control-ui-e2e] screenshot: ${output}`);
      return output;
    };
    const screenshotPath = screenshotFor(requestedScreenshotPath, "initial");
    const progressScreenshotPath = screenshotFor(requestedProgressScreenshotPath, "progress");
    const errorScreenshotPath = screenshotFor(requestedErrorScreenshotPath, "error");
    const videoDir = requestedVideoDir ? directoryFor(requestedVideoDir) : undefined;
    await suite.withPage(
      {
        serviceWorkers: "block",
        viewport: { width: 1280, height: 800 },
        ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } } : {}),
      },
      async ({ page }) => {
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

        await page.goto(`${suite.server.baseUrl}focus/terminal`);
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
      },
    );
  });
});
