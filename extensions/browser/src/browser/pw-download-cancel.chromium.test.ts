import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { DEFAULT_UPLOAD_DIR } from "./paths.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import { ensurePageState } from "./pw-session-state.js";
import { closePlaywrightBrowserConnection, getPageForTargetId } from "./pw-session.js";
import {
  armDialogViaPlaywright,
  downloadViaPlaywright,
  uploadViaPlaywright,
  waitForDownloadViaPlaywright,
} from "./pw-tools-core.downloads.js";
import { clickViaPlaywright, typeViaPlaywright } from "./pw-tools-core.interactions.actions.js";
import { setInputFilesViaPlaywright } from "./pw-tools-core.interactions.content.js";
import { executeActViaPlaywright } from "./pw-tools-core.interactions.execution.js";
import { snapshotRoleViaPlaywright } from "./pw-tools-core.snapshot.js";
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

describe.runIf(runChromiumProof)("managed Chromium action and download cancellation", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    const errors: unknown[] = [];
    for (const dispose of cleanup.splice(0).toReversed()) {
      await dispose().catch((error: unknown) => errors.push(error));
    }
    if (errors.length) {
      throw new AggregateError(errors, "Chromium download fixture cleanup failed");
    }
  });

  async function createUploadFile() {
    await fs.mkdir(DEFAULT_UPLOAD_DIR, { recursive: true });
    const uploadDir = await fs.mkdtemp(path.join(DEFAULT_UPLOAD_DIR, "action-cancel-"));
    cleanup.push(async () => await fs.rm(uploadDir, { recursive: true, force: true }));
    const filePath = path.join(uploadDir, "proof.txt");
    await fs.writeFile(filePath, "synthetic upload proof");
    return filePath;
  }

  async function createActionPages(html: string[]) {
    const rootDir = tempDirs.make("openclaw-action-cancel-");
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
    const cdpUrl = `http://127.0.0.1:${cdpPort}`;
    cleanup.push(async () => await closePlaywrightBrowserConnection({ cdpUrl }));
    const pages = [];
    for (const [index, content] of html.entries()) {
      const owner = index === 0 ? context.pages()[0]! : await context.newPage();
      await owner.setContent(content);
      const targetId = await readTargetId(owner);
      const controlled = await getPageForTargetId({ cdpUrl, targetId });
      const snapshot = await snapshotRoleViaPlaywright({ cdpUrl, targetId });
      pages.push({ owner, controlled, targetId, refs: snapshot.refs });
    }
    return { cdpUrl, pages };
  }

  function observeLocatorAction(page: import("playwright-core").Page, method: "click" | "fill") {
    const started = createDeferred<void>();
    const settled = createDeferred<void>();
    const frame = page.mainFrame();
    // Observe the real dependency promise so cancellation assertions cannot race
    // ahead of native action admission or mistake an outer abort race for cleanup.
    const observe = (pending: Promise<void>) => {
      started.resolve();
      void pending.then(settled.resolve, settled.resolve);
      return pending;
    };
    if (method === "click") {
      const click = frame.click.bind(frame);
      frame.click = (selector, options) => observe(click(selector, options));
    } else {
      const fill = frame.fill.bind(frame);
      frame.fill = (selector, value, options) => observe(fill(selector, value, options));
    }
    return { started: started.promise, settled: settled.promise };
  }

  async function waitForNativeAction(started: Promise<void>, outcome: Promise<unknown>) {
    await Promise.race([
      started,
      outcome.then((result) => {
        throw new Error("Action settled before native admission", { cause: result });
      }),
    ]);
  }

  it("cancels one page's click while another page's pending click completes", async () => {
    const html = "<button onclick=\"this.textContent='Clicked'\">Target</button>";
    const { cdpUrl, pages } = await createActionPages([html, html]);
    const [first, second] = pages;
    const firstRef = Object.keys(first!.refs)[0]!;
    const secondRef = Object.keys(second!.refs)[0]!;
    for (const page of pages) {
      await page.owner
        .locator("button")
        .evaluate((element: HTMLButtonElement) => (element.disabled = true));
    }
    const firstNative = observeLocatorAction(first!.controlled, "click");
    const secondNative = observeLocatorAction(second!.controlled, "click");
    const controller = new AbortController();
    const reason = new Error("only the first action was cancelled");
    const firstClick = clickViaPlaywright({
      cdpUrl,
      targetId: first!.targetId,
      ref: firstRef,
      signal: controller.signal,
      timeoutMs: 5_000,
    }).catch((error: unknown) => error);
    const secondClick = clickViaPlaywright({
      cdpUrl,
      targetId: second!.targetId,
      ref: secondRef,
      timeoutMs: 5_000,
    }).then(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, error }),
    );
    await Promise.all([
      waitForNativeAction(firstNative.started, firstClick),
      waitForNativeAction(secondNative.started, secondClick),
    ]);
    controller.abort(reason);
    await expect(firstClick).resolves.toBe(reason);
    await firstNative.settled;
    await second!.owner
      .locator("button")
      .evaluate((element: HTMLButtonElement) => (element.disabled = false));

    await expect(secondClick).resolves.toEqual({ ok: true });
    await expect(second!.owner.locator("button").textContent()).resolves.toBe("Clicked");
    expect(second!.controlled.context().browser()?.isConnected()).toBe(true);
  }, 20_000);

  it("does not type after a cancelled input becomes editable", async () => {
    const { cdpUrl, pages } = await createActionPages(["<label>Entry<input></label>"]);
    const page = pages[0]!;
    const ref = Object.keys(page.refs)[0]!;
    await page.owner
      .locator("input")
      .evaluate((element: HTMLInputElement) => (element.disabled = true));
    const native = observeLocatorAction(page.controlled, "fill");
    const controller = new AbortController();
    const reason = new Error("typing was cancelled");
    const typing = typeViaPlaywright({
      cdpUrl,
      targetId: page.targetId,
      ref,
      text: "cancelled input",
      timeoutMs: 5_000,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await waitForNativeAction(native.started, typing);
    controller.abort(reason);
    await expect(typing).resolves.toBe(reason);
    await page.owner
      .locator("input")
      .evaluate((element: HTMLInputElement) => (element.disabled = false));
    await native.settled;

    await expect(page.owner.locator("input").inputValue()).resolves.toBe("");
    expect(page.controlled.context().browser()?.isConnected()).toBe(true);
  }, 20_000);

  it("completes uploads on separate pages without superseding either request", async () => {
    const filePath = await createUploadFile();
    const html =
      '<button onclick="document.querySelector(\'input\').click()">Upload</button><input type="file" hidden>';
    const { cdpUrl, pages } = await createActionPages([html, html]);
    const [first, second] = pages;
    await first!.owner
      .locator("button")
      .evaluate((element: HTMLButtonElement) => (element.disabled = true));
    const native = observeLocatorAction(first!.controlled, "click");
    const firstUpload = uploadViaPlaywright({
      cdpUrl,
      targetId: first!.targetId,
      ref: Object.keys(first!.refs)[0]!,
      paths: [filePath],
      timeoutMs: 5_000,
    }).then(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, error }),
    );
    await waitForNativeAction(native.started, firstUpload);
    await uploadViaPlaywright({
      cdpUrl,
      targetId: second!.targetId,
      ref: Object.keys(second!.refs)[0]!,
      paths: [filePath],
      timeoutMs: 5_000,
    });
    await first!.owner
      .locator("button")
      .evaluate((element: HTMLButtonElement) => (element.disabled = false));
    await expect(firstUpload).resolves.toEqual({ ok: true });
    for (const page of pages) {
      await expect(
        page.owner
          .locator("input")
          .evaluate((element: HTMLInputElement) => element.files?.[0]?.name),
      ).resolves.toBe("proof.txt");
    }
  }, 20_000);

  it("does not assign files to an input that appears after cancellation", async () => {
    const filePath = await createUploadFile();
    const { cdpUrl, pages } = await createActionPages(["<p>Waiting for a file input</p>"]);
    const page = pages[0]!;
    const started = createDeferred<void>();
    const settled = createDeferred<void>();
    const frame = page.controlled.mainFrame();
    const setInputFiles = frame.setInputFiles.bind(frame);
    frame.setInputFiles = (selector, files, options) => {
      const pending = setInputFiles(selector, files, options);
      started.resolve();
      void pending.then(settled.resolve, settled.resolve);
      return pending;
    };
    const controller = new AbortController();
    const reason = new Error("direct upload cancelled");
    const upload = setInputFilesViaPlaywright({
      cdpUrl,
      targetId: page.targetId,
      element: "input[type=file]",
      paths: [filePath],
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await started.promise;
    controller.abort(reason);
    await expect(upload).resolves.toBe(reason);
    await page.owner.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file";
      document.body.append(input);
    });
    await settled.promise;
    await expect(
      page.owner.locator("input").evaluate((element: HTMLInputElement) => element.files?.length),
    ).resolves.toBe(0);
    expect(page.controlled.context().browser()?.isConnected()).toBe(true);
  }, 20_000);

  it("reports an open dialog while retaining the click until the dialog is answered", async () => {
    const { cdpUrl, pages } = await createActionPages([
      "<button onclick=\"this.textContent=confirm('Continue?') ? 'Accepted' : 'Dismissed'\">Confirm</button>",
    ]);
    const page = pages[0]!;
    page.owner.on("dialog", () => {});
    const native = observeLocatorAction(page.controlled, "click");
    let settled = false;
    void native.settled.then(() => {
      settled = true;
    });
    const result = await executeActViaPlaywright({
      cdpUrl,
      targetId: page.targetId,
      action: { kind: "click", ref: Object.keys(page.refs)[0]! },
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });
    expect(result).toMatchObject({
      blockedByDialog: true,
      browserState: { dialogs: { pending: [{ type: "confirm", message: "Continue?" }] } },
    });
    expect(settled).toBe(false);
    expect(page.controlled.context().browser()?.isConnected()).toBe(true);
    await armDialogViaPlaywright({ cdpUrl, targetId: page.targetId, accept: true });
    await native.settled;
    await expect(page.owner.locator("button").textContent()).resolves.toBe("Accepted");
  }, 20_000);

  it.each(["caller abort", "invalid output directory"])(
    "cancels a streaming download after %s without publishing output",
    async (failure) => {
      const rootDir = tempDirs.make("openclaw-download-stream-cancel-");
      cleanup.push(async () => await fs.rm(rootDir, { recursive: true, force: true }));
      let closeDownloadResponse: (() => void) | undefined;
      let responseClosed = false;
      const downloadServer = createServer((request, response) => {
        if (request.url === "/stream.bin") {
          response.writeHead(200, {
            "content-disposition": 'attachment; filename="stream.bin"',
            "content-type": "application/octet-stream",
          });
          response.write("partially downloaded bytes");
          response.once("close", () => {
            responseClosed = true;
          });
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
      cleanup.push(async () => closeDownloadResponse?.());

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
      if (failure === "invalid output directory") {
        await fs.writeFile(outputRoot, "not a directory");
      }
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
      if (failure === "caller abort") {
        await Promise.race([saveStarted.promise, capture]);
        controller.abort(reason);
        await expect(outcome).resolves.toBe(reason);
        await expect.poll(async () => await fs.readdir(outputRoot)).toEqual([]);
        await expect(fs.access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(outcome).resolves.toMatchObject({
          message: "Invalid path: must stay within output directory",
        });
        await expect(fs.readFile(outputRoot, "utf8")).resolves.toBe("not a directory");
      }

      expect.soft(cancellationCount).toBe(1);
      await expect.poll(() => responseClosed).toBe(true);
      expect(ensurePageState(controlledPage).downloadWaiterDepth).toBe(0);
    },
    20_000,
  );

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
