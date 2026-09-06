// Browser tests cover pw tools core.last file chooser arm wins plugin behavior.
import crypto from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_UPLOAD_DIR } from "./paths.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.downloads.js");
const interactions = await import("./pw-tools-core.interactions.js");

describe("pw-tools-core", () => {
  it("last file-chooser arm wins", async () => {
    const firstPath = path.join(DEFAULT_UPLOAD_DIR, `vitest-arm-1-${crypto.randomUUID()}.txt`);
    const secondPath = path.join(DEFAULT_UPLOAD_DIR, `vitest-arm-2-${crypto.randomUUID()}.txt`);
    await fs.mkdir(DEFAULT_UPLOAD_DIR, { recursive: true });
    await Promise.all([
      fs.writeFile(firstPath, "1", "utf8"),
      fs.writeFile(secondPath, "2", "utf8"),
    ]);
    const secondCanonicalPath = await fs.realpath(secondPath);

    const chooserEvents = new EventEmitter();
    const fileChooser = {
      setFiles: vi.fn(
        async (_paths: string[], _options: { timeout: number; signal: AbortSignal }) => {},
      ),
    };
    // Native event waiters reject on abort and remove their old chooser listener.
    const waitForEvent = vi.fn(async (_event: string, { signal }: { signal: AbortSignal }) => {
      const [chooser] = await once(chooserEvents, "filechooser", { signal });
      return chooser;
    });

    setPwToolsCoreCurrentPage({
      waitForEvent,
      keyboard: { press: vi.fn(async () => {}) },
    });

    try {
      await mod.armFileUploadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        paths: [firstPath],
      });
      await mod.armFileUploadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        paths: [secondPath],
      });

      expect(waitForEvent).toHaveBeenCalledTimes(2);
      expect(waitForEvent.mock.calls[0]![1].signal.aborted).toBe(true);
      expect(chooserEvents.listenerCount("filechooser")).toBe(1);
      chooserEvents.emit("filechooser", fileChooser);
      await vi.waitFor(() => {
        expect(fileChooser.setFiles).toHaveBeenCalledExactlyOnceWith([secondCanonicalPath], {
          timeout: expect.any(Number),
          signal: expect.any(AbortSignal),
        });
      });
      const { timeout, signal } = fileChooser.setFiles.mock.calls[0]![1];
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(120_000);
      expect(signal.aborted).toBe(false);
      expect(chooserEvents.listenerCount("filechooser")).toBe(0);
    } finally {
      chooserEvents.emit("filechooser", fileChooser);
      await Promise.all([fs.rm(firstPath, { force: true }), fs.rm(secondPath, { force: true })]);
    }
  });
  it("arms the next dialog and accepts/dismisses (default timeout)", async () => {
    const sessionMocks = getPwToolsCoreSessionMocks();
    const page = {};
    setPwToolsCoreCurrentPage(page);

    await mod.armDialogViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      accept: true,
      promptText: "x",
    });

    expect(sessionMocks.respondToObservedDialogOnPage).toHaveBeenCalledWith({
      page,
      accept: true,
      promptText: "x",
      closedBy: "agent",
    });
    expect(sessionMocks.armObservedDialogResponseOnPage).toHaveBeenCalledWith({
      page,
      accept: true,
      promptText: "x",
      timeoutMs: 120_000,
    });

    sessionMocks.respondToObservedDialogOnPage.mockClear();
    sessionMocks.armObservedDialogResponseOnPage.mockClear();

    await mod.armDialogViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      accept: false,
    });

    expect(sessionMocks.armObservedDialogResponseOnPage).toHaveBeenCalledWith({
      page,
      accept: false,
      timeoutMs: 120_000,
    });
  });
  it("waits for selector, url, load state, and function", async () => {
    const waitForSelector = vi.fn(async () => {});
    const waitForURL = vi.fn(async () => {});
    const waitForLoadState = vi.fn(async () => {});
    const waitForFunction = vi.fn(
      async (_predicate: unknown, _state: unknown, _options: unknown) => {},
    );
    const waitForTimeout = vi.fn(async () => {});
    const documentHandle = { dispose: vi.fn(async () => {}) };

    const page = {
      evaluateHandle: vi.fn(async () => documentHandle),
      locator: vi.fn(() => ({
        first: () => ({ waitFor: waitForSelector }),
      })),
      waitForURL,
      waitForLoadState,
      waitForFunction,
      waitForTimeout,
      getByText: vi.fn(() => ({ first: () => ({ waitFor: vi.fn() }) })),
    };
    setPwToolsCoreCurrentPage(page);

    await interactions.waitForViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      selector: "#main",
      url: "**/dash",
      loadState: "networkidle",
      fn: "window.ready===true",
      timeoutMs: 1234,
      timeMs: 50,
    });

    expect(waitForTimeout).toHaveBeenCalledWith(50);
    expect(page.locator as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("#main");
    expect(waitForSelector).toHaveBeenCalledWith({
      state: "visible",
      timeout: 1234,
    });
    expect(waitForURL).toHaveBeenCalledWith("**/dash", { timeout: 1234 });
    expect(waitForLoadState).toHaveBeenCalledWith("networkidle", {
      timeout: 1234,
    });
    expect(waitForFunction).toHaveBeenCalledWith(
      expect.any(Function),
      { document: documentHandle },
      { timeout: 1234 },
    );
    expect(String(waitForFunction.mock.calls[0]?.[0])).toContain("window.ready===true");
    expect(documentHandle.dispose).toHaveBeenCalledOnce();
  });

  it("clamps wait timeoutMs to 120000 for wait steps", async () => {
    const waitForSelector = vi.fn(async () => {});
    const page = {
      locator: vi.fn(() => ({
        first: () => ({ waitFor: waitForSelector }),
      })),
      waitForURL: vi.fn(async () => {}),
      waitForLoadState: vi.fn(async () => {}),
      waitForFunction: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      getByText: vi.fn(() => ({ first: () => ({ waitFor: vi.fn() }) })),
    };
    setPwToolsCoreCurrentPage(page);

    await interactions.waitForViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      selector: "#main",
      timeoutMs: 999_999,
    });

    expect(waitForSelector).toHaveBeenCalledWith({
      state: "visible",
      timeout: 120_000,
    });
  });

  it("clamps interaction timeoutMs to 60000 for click steps", async () => {
    const click = vi.fn(async () => {});
    const page = {
      url: vi.fn(() => "https://example.com"),
      locator: vi.fn(() => ({ click })),
    };
    setPwToolsCoreCurrentPage(page);

    await interactions.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      selector: "#main",
      timeoutMs: 999_999,
    });

    expect(click).toHaveBeenCalledWith({ timeout: 60_000, signal: expect.any(AbortSignal) });
  });
});
