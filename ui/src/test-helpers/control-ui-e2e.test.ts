// Control UI tests cover control ui e2e behavior.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import { captureSidebarUiProof } from "../e2e/sidebar-customization.test-support.ts";
import { createControlUiE2eArtifactDir } from "./control-ui-e2e-artifacts.ts";
import {
  captureControlUiE2eFailureDiagnostics,
  resolvePlaywrightChromiumExecutablePath,
  systemChromiumExecutableCandidates,
  waitForControlUiRoute,
} from "./control-ui-e2e.ts";

describe("shared proof capture", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => vi.unstubAllEnvs());

  it("keeps each failure screenshot and report in its own retained directory", async () => {
    const parent = tempDirs.make("control-ui-failure-proof-");
    vi.stubEnv("OPENCLAW_UI_E2E_DIAGNOSTIC_DIR", parent);
    writeFileSync(path.join(parent, "prior.png"), "prior-proof");
    // SAFETY: this fixture implements the Page boundary used by failure diagnostics.
    const page = {
      evaluate: async () => ({ marker: "failed-page" }),
      isClosed: () => false,
      url: () => "http://127.0.0.1/chat",
      screenshot: async (options: { path: string }) => {
        writeFileSync(options.path, "failure-proof");
        return Buffer.from("failure-proof");
      },
    } as unknown as Page;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await captureControlUiE2eFailureDiagnostics(page, {
        error: new Error("Synthetic request timeout"),
        label: "chat.send",
      });
    }
    const directories = readdirSync(parent, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory(),
    );
    expect(directories).toHaveLength(2);
    for (const directory of directories) {
      const root = path.join(parent, directory.name);
      const files = readdirSync(root);
      expect(files).toHaveLength(2);
      const reportFile = files.find((file) => file.endsWith(".json"));
      expect(reportFile).toBeDefined();
      const report = JSON.parse(readFileSync(path.join(root, reportFile!), "utf8"));
      expect(report).toMatchObject({ label: "chat.send", captureErrors: [] });
      expect(files).toContain(report.screenshot);
      expect(readFileSync(path.join(root, report.screenshot), "utf8")).toBe("failure-proof");
    }
    expect(readFileSync(path.join(parent, "prior.png"), "utf8")).toBe("prior-proof");
  });

  it("keeps shared capture disabled until its gate is enabled and uses the supplied owner", async () => {
    const parent = tempDirs.make("control-ui-proof-capture-");
    vi.stubEnv("OPENCLAW_UI_E2E_ARTIFACT_DIR", parent);
    vi.stubEnv("OPENCLAW_CAPTURE_UI_PROOF", "0");
    let directory: string | undefined;
    const owner = {
      get artifactDir() {
        return (directory ??= createControlUiE2eArtifactDir("sidebar", parent));
      },
    };
    const screenshot = vi.fn(async (options: { path: string }) => {
      // A broken caller must fail before it can write outside this test's owned directory.
      expect(options.path).toBe(path.join(owner.artifactDir, "state.png"));
      writeFileSync(options.path, "sidebar-proof");
      return Buffer.from("sidebar-proof");
    });
    // SAFETY: this fixture implements only the screenshot method used by the capture helper.
    const page = { screenshot } as unknown as Page;

    await captureSidebarUiProof(owner, page, "state.png");
    expect(readdirSync(parent)).toEqual([]);
    expect(screenshot).not.toHaveBeenCalled();

    vi.stubEnv("OPENCLAW_CAPTURE_UI_PROOF", "1");
    await captureSidebarUiProof(owner, page, "state.png");
    expect(readFileSync(path.join(owner.artifactDir, "state.png"), "utf8")).toBe("sidebar-proof");
  });
});

describe("resolvePlaywrightChromiumExecutablePath", () => {
  it("uses a runnable system Chromium when the cached Playwright executable cannot start", () => {
    const systemExecutable = systemChromiumExecutableCandidates[1];

    expect(
      resolvePlaywrightChromiumExecutablePath(
        "/cache/chromium/chrome",
        {},
        (candidate) => candidate === systemExecutable,
      ),
    ).toBe(systemExecutable);
  });

  it("keeps explicit Chromium overrides authoritative", () => {
    expect(
      resolvePlaywrightChromiumExecutablePath(
        "/cache/chromium/chrome",
        { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: " /custom/chromium " },
        () => false,
      ),
    ).toBe("/custom/chromium");
  });
});

describe("waitForControlUiRoute", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps polling while a new tab has no app element", async () => {
    // SAFETY: this fixture implements the Page methods used by the route helper.
    const page = {
      async waitForFunction(
        predicate: (target: { routeId: string }) => boolean,
        target: { routeId: string },
      ) {
        expect(predicate(target)).toBe(false);
        const app = document.createElement("openclaw-app");
        Object.assign(app, {
          runtime: {
            router: {
              getState: () => ({
                status: "success",
                resolvedLocation: { pathname: window.location.pathname },
                matches: [{ routeId: "chat" }],
                pendingMatches: [],
              }),
            },
          },
        });
        document.body.append(app);
        expect(predicate(target)).toBe(true);
        return { dispose: vi.fn() };
      },
      evaluate: (read: () => unknown) => read(),
    } as unknown as Page;

    await waitForControlUiRoute(page, { routeId: "chat" });
  });

  it("preserves readiness failures when the app is still absent", async () => {
    const cause = new Error("Route readiness failed");
    // SAFETY: this fixture implements the Page methods used by the route helper.
    const page = {
      waitForFunction: vi.fn().mockRejectedValue(cause),
      evaluate: (read: () => unknown) => read(),
    } as unknown as Page;

    await expect(waitForControlUiRoute(page, { routeId: "chat" })).rejects.toMatchObject({
      cause,
      message: expect.stringContaining('"router":null'),
    });
  });
});
