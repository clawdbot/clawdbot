import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import { ensurePageState } from "./pw-session-state.js";
import { closePlaywrightBrowserConnection, getPageForTargetId } from "./pw-session.js";
import { downloadViaPlaywright, waitForDownloadViaPlaywright } from "./pw-tools-core.downloads.js";
import { getFreePort } from "./test-port.js";

const runChromiumProof = process.env.OPENCLAW_BROWSER_DOWNLOAD_E2E === "1";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readTargetId(page: import("playwright-core").Page): Promise<string> {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    return targetInfo.targetId;
  } finally {
    await session.detach();
  }
}

describe.runIf(runChromiumProof)("managed Chromium download cancellation", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const dispose of cleanup.splice(0).toReversed()) {
      await dispose();
    }
  });

  it("cancels a download already being streamed without publishing its output", async () => {
    const rootDir = tempDirs.make("openclaw-download-stream-cancel-");
    cleanup.push(async () => await fs.rm(rootDir, { recursive: true, force: true }));
    let closeDownloadResponse: (() => void) | undefined;
    const downloadServer = createServer((request, response) => {
      if (request.url === "/stream.bin") {
        response.writeHead(200, {
          "content-disposition": 'attachment; filename="stream.bin"',
          "content-type": "application/octet-stream",
        });
        response.write("partially downloaded bytes");
        closeDownloadResponse = () => response.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<a id="download" href="/stream.bin" download>Download</a>');
    });
    const downloadPort = await listen(downloadServer);
    cleanup.push(async () => {
      closeDownloadResponse?.();
      await closeServer(downloadServer);
    });

    const cdpPort = await getFreePort();
    const context = await getPlaywrightCore().chromium.launchPersistentContext(
      path.join(rootDir, "profile"),
      {
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        args: [`--remote-debugging-port=${cdpPort}`],
      },
    );
    cleanup.push(async () => await context.close());
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`http://127.0.0.1:${downloadPort}/`);
    const cdpUrl = `http://127.0.0.1:${cdpPort}`;
    const targetId = await readTargetId(page);
    cleanup.push(async () => await closePlaywrightBrowserConnection({ cdpUrl }));

    const controlledPage = await getPageForTargetId({ cdpUrl, targetId });
    const saveStarted = createDeferred<void>();
    let cancellationCount = 0;
    controlledPage.once("download", (download) => {
      const saveAs = download.saveAs.bind(download);
      const cancel = download.cancel.bind(download);
      download.saveAs = async (outputPath) => {
        saveStarted.resolve();
        await saveAs(outputPath);
      };
      download.cancel = async () => {
        cancellationCount += 1;
        await cancel();
      };
    });

    const outputRoot = path.join(rootDir, "downloads");
    const outputPath = path.join(outputRoot, "cancelled.bin");
    const controller = new AbortController();
    const reason = new Error("streaming download aborted");
    const capture = waitForDownloadViaPlaywright({
      cdpUrl,
      targetId,
      path: outputPath,
      rootDir: outputRoot,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    const outcome = capture.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );
    await expect.poll(() => ensurePageState(controlledPage).downloadWaiterDepth).toBe(1);
    await page.locator("#download").click();
    await saveStarted.promise;
    controller.abort(reason);

    expect(cancellationCount).toBe(1);
    await expect(outcome).resolves.toBe(reason);
    await expect.poll(async () => await fs.readdir(outputRoot)).toEqual([]);
    await expect(fs.access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(ensurePageState(controlledPage).downloadWaiterDepth).toBe(0);
  }, 20_000);

  it("does not let a cancelled waiter capture and write a later download", async () => {
    const rootDir = tempDirs.make("openclaw-download-cancel-");
    cleanup.push(async () => await fs.rm(rootDir, { recursive: true, force: true }));

    const abandonedPayload = Buffer.from("abandoned-click-download\n");
    const successorPayload = Buffer.from("successor-download\n");
    const downloadServer = createServer((request, response) => {
      if (request.url === "/late.txt") {
        response.writeHead(200, {
          "content-disposition": 'attachment; filename="duplicate.txt"',
          "content-length": String(abandonedPayload.byteLength),
          "content-type": "text/plain",
        });
        response.end(abandonedPayload);
        return;
      }
      if (request.url === "/successor.txt") {
        response.writeHead(200, {
          "content-disposition": 'attachment; filename="duplicate.txt"',
          "content-length": String(successorPayload.byteLength),
          "content-type": "text/plain",
        });
        response.end(successorPayload);
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        '<button id="delayed" disabled onclick="location.href=\'/late.txt\'">Delayed Download</button>' +
          '<a id="download" href="/successor.txt" download>Download</a>',
      );
    });
    const downloadPort = await listen(downloadServer);
    cleanup.push(async () => await closeServer(downloadServer));

    const cdpPort = await getFreePort();
    const profileDir = path.join(rootDir, "profile");
    const context = await getPlaywrightCore().chromium.launchPersistentContext(profileDir, {
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: [`--remote-debugging-port=${cdpPort}`],
    });
    cleanup.push(async () => await context.close());
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`http://127.0.0.1:${downloadPort}/`);

    const cdpUrl = `http://127.0.0.1:${cdpPort}`;
    const targetId = await readTargetId(page);
    cleanup.push(async () => await closePlaywrightBrowserConnection({ cdpUrl }));
    const outputRoot = path.join(rootDir, "downloads");
    const outputPath = path.join(outputRoot, "cancelled.txt");
    const controller = new AbortController();
    const wait = waitForDownloadViaPlaywright({
      cdpUrl,
      targetId,
      path: outputPath,
      rootDir: outputRoot,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    const outcome = wait.then(
      (download) => ({ kind: "resolved" as const, download }),
      (error: unknown) => ({
        kind: "rejected" as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    );

    const controlledPage = await getPageForTargetId({ cdpUrl, targetId });
    await expect.poll(() => ensurePageState(controlledPage).downloadWaiterDepth).toBe(1);
    controller.abort(new Error("request aborted"));
    const afterAbort = await Promise.race([
      outcome,
      new Promise<{ kind: "pending" }>((resolve) => {
        setTimeout(() => resolve({ kind: "pending" }), 200);
      }),
    ]);

    const successorPath = path.join(outputRoot, "successor.txt");
    const successor = waitForDownloadViaPlaywright({
      cdpUrl,
      targetId,
      path: successorPath,
      rootDir: outputRoot,
      timeoutMs: 5_000,
    });
    await expect.poll(() => ensurePageState(controlledPage).downloadWaiterDepth).toBe(1);
    await page.locator("#download").click();
    const finalOutcome = await outcome;
    const written = await fs.readFile(outputPath).catch(() => undefined);
    const successorResult = await successor;

    expect({
      afterAbort,
      finalOutcome,
      written: written?.toString("utf8"),
      successor: {
        bytes: await fs.readFile(successorResult.path, "utf8"),
        suggestedFilename: successorResult.suggestedFilename,
      },
    }).toEqual({
      afterAbort: { kind: "rejected", message: "request aborted" },
      finalOutcome: { kind: "rejected", message: "request aborted" },
      written: undefined,
      successor: {
        bytes: successorPayload.toString("utf8"),
        suggestedFilename: "duplicate.txt",
      },
    });

    const pageState = ensurePageState(controlledPage);
    pageState.roleRefs = { e1: { role: "button", name: "Delayed Download" } };
    pageState.roleRefsMode = "role";
    await page.evaluate(() => {
      setTimeout(() => {
        const delayed = document.querySelector<HTMLButtonElement>("#delayed");
        if (delayed) {
          delayed.disabled = false;
        }
      }, 500);
    });
    const sharedPath = path.join(outputRoot, "shared.txt");
    const clickController = new AbortController();
    const cancelledClick = downloadViaPlaywright({
      cdpUrl,
      targetId,
      ref: "e1",
      path: sharedPath,
      rootDir: outputRoot,
      timeoutMs: 5_000,
      signal: clickController.signal,
    });
    const clickOutcome = cancelledClick.then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({
        kind: "rejected" as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    await expect.poll(() => pageState.downloadWaiterDepth).toBe(1);
    clickController.abort(new Error("click request aborted"));
    const clickAfterAbort = await Promise.race([
      clickOutcome,
      new Promise<{ kind: "pending" }>((resolve) => {
        setTimeout(() => resolve({ kind: "pending" }), 200);
      }),
    ]);
    expect(clickAfterAbort).toEqual({ kind: "rejected", message: "click request aborted" });
    expect(pageState.downloadWaiterDepth).toBe(0);

    const clickSuccessor = waitForDownloadViaPlaywright({
      cdpUrl,
      targetId,
      path: sharedPath,
      rootDir: outputRoot,
      timeoutMs: 5_000,
    });
    await expect.poll(() => pageState.downloadWaiterDepth).toBe(1);
    const beforeSuccessorClick = await Promise.race([
      clickSuccessor.then(() => "resolved" as const),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 700);
      }),
    ]);
    expect(beforeSuccessorClick).toBe("pending");
    await expect(fs.access(sharedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await page.locator("#download").click();
    const clickSuccessorResult = await clickSuccessor;
    await expect(fs.readFile(clickSuccessorResult.path, "utf8")).resolves.toBe(
      successorPayload.toString("utf8"),
    );

    await closePlaywrightBrowserConnection({ cdpUrl });
    await context.close();

    const restartedCdpPort = await getFreePort();
    const restartedContext = await getPlaywrightCore().chromium.launchPersistentContext(
      profileDir,
      {
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        args: [`--remote-debugging-port=${restartedCdpPort}`],
      },
    );
    cleanup.push(async () => await restartedContext.close());
    const restartedPage = restartedContext.pages()[0] ?? (await restartedContext.newPage());
    await restartedPage.goto(`http://127.0.0.1:${downloadPort}/`);
    const restartedCdpUrl = `http://127.0.0.1:${restartedCdpPort}`;
    const restartedTargetId = await readTargetId(restartedPage);
    cleanup.push(async () => await closePlaywrightBrowserConnection({ cdpUrl: restartedCdpUrl }));

    const downloadAfterRestart = async () => {
      const pending = waitForDownloadViaPlaywright({
        cdpUrl: restartedCdpUrl,
        targetId: restartedTargetId,
        rootDir: outputRoot,
        timeoutMs: 5_000,
      });
      const connected = await getPageForTargetId({
        cdpUrl: restartedCdpUrl,
        targetId: restartedTargetId,
      });
      await expect.poll(() => ensurePageState(connected).downloadWaiterDepth).toBe(1);
      await restartedPage.locator("#download").click();
      return await pending;
    };
    const firstDuplicate = await downloadAfterRestart();
    const secondDuplicate = await downloadAfterRestart();

    expect(firstDuplicate.suggestedFilename).toBe("duplicate.txt");
    expect(secondDuplicate.suggestedFilename).toBe("duplicate.txt");
    expect(firstDuplicate.path).not.toBe(secondDuplicate.path);
    await expect(fs.readFile(firstDuplicate.path, "utf8")).resolves.toBe(
      successorPayload.toString("utf8"),
    );
    await expect(fs.readFile(secondDuplicate.path, "utf8")).resolves.toBe(
      successorPayload.toString("utf8"),
    );
    expect((await fs.readdir(outputRoot)).some((name) => name.endsWith(".part"))).toBe(false);

    await closePlaywrightBrowserConnection({ cdpUrl: restartedCdpUrl });
    await restartedContext.close();
    await fs.rm(rootDir, { recursive: true, force: true });
    await expect(fs.access(rootDir)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});
