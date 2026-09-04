import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, vi } from "vitest";
import { getActiveGatewayRootWorkCount } from "../../../src/process/gateway-work-admission.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  captureControlUiE2eFailureDiagnostics,
  controlUiE2eWaitTimeoutMs,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

declare module "vitest" {
  export interface ProvidedContext {
    controlUiE2eChromium: { executablePath: string; available: boolean };
  }
}

type ControlUiE2eSuiteOptions = {
  browserLaunchOptions?: Omit<NonNullable<Parameters<typeof chromium.launch>[0]>, "executablePath">;
  name: string;
  startServer?: () => Promise<ControlUiE2eServer>;
  startServerBeforeBrowser?: boolean;
  trackBrowserContexts?: boolean;
  unavailableMessage?: (executablePath: string) => string;
};

type ControlUiE2ePage = {
  context: BrowserContext;
  page: Page;
};

type ControlUiE2eSuite = {
  readonly artifactDir: string;
  readonly browser: Browser;
  readonly server: ControlUiE2eServer;
  closeBrowserContext: (context: BrowserContext) => Promise<void>;
  define: (defineTests: () => void) => void;
  newBrowserContext: (options: Parameters<Browser["newContext"]>[0]) => Promise<BrowserContext>;
  withPage: <T>(
    options: Parameters<Browser["newContext"]>[0],
    run: (fixture: ControlUiE2ePage) => Promise<T>,
    cleanup?: (fixture: ControlUiE2ePage) => Promise<void>,
  ) => Promise<T>;
};

/* The shared title tooltip (components/tooltip-title.ts) lifts a hovered or
   focused element's `title` into its overlay and blanks the attribute until
   pointer-leave/focusout, so elements that can sit under the pointer or hold
   focus race a raw getAttribute("title") read. Read the lifted overlay
   description when the attribute is blank. */
export function tooltipTitleText(item: Locator) {
  return item.evaluate((element) => {
    const title = element.getAttribute("title");
    if (title) {
      return title;
    }
    // The overlay describes the first interactive descendant when the titled
    // row itself is not describable (tooltip.ts resolveDescribedElement), so
    // link rows carry the description on their nested anchor.
    const described = element.hasAttribute("aria-describedby")
      ? element
      : (element.querySelector("[aria-describedby]") ?? element);
    const root = described.getRootNode();
    const scope = root instanceof ShadowRoot ? root : described.ownerDocument;
    return (described.getAttribute("aria-describedby") ?? "")
      .split(/\s+/u)
      .map((id) => scope.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
  });
}

export async function holdModuleResponse(page: Page, module: RegExp) {
  let release!: () => void;
  let requested!: (url: string) => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const request = new Promise<string>((resolve) => {
    requested = resolve;
  });
  let requests = 0;
  await page.route(module, async (route) => {
    requests += 1;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    requested(route.request().url());
    await gate;
    await route.fulfill({ response });
  });
  return { request, release, requests: () => requests };
}

export async function closeControlUiE2eBrowserContext(context: BrowserContext): Promise<void> {
  await context.close();
  // Requests outlive sockets; Gateway cleanup must not retire their admission
  // roots before pending handlers (including lazy imports) have finished.
  // waitFor also works in afterAll; retain the UI E2E config's poll budget.
  await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0), {
    interval: 100,
    timeout: 15_000,
  });
}

export function createControlUiE2eSuite(options: ControlUiE2eSuiteOptions): ControlUiE2eSuite {
  // Global setup already checked the executable; keep that result across isolated files.
  const { executablePath: chromiumExecutablePath, available: chromiumAvailable } =
    inject("controlUiE2eChromium");
  const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
  const describeControlUiE2e =
    chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
  const openBrowserContexts = new Set<BrowserContext>();
  let browser: Browser | undefined;
  let server: ControlUiE2eServer | undefined;
  let artifactDir: string | undefined;

  const closeBrowserContext = async (context: BrowserContext): Promise<void> => {
    // Retain failed closes for the final browser teardown owner.
    await closeControlUiE2eBrowserContext(context);
    openBrowserContexts.delete(context);
  };
  const closeOpenBrowserContexts = async (): Promise<void> => {
    const [first, ...remaining] = openBrowserContexts;
    if (!first) {
      return;
    }
    await runQaGatewayFixture(
      () => closeBrowserContext(first),
      ...remaining.map((context) => () => closeBrowserContext(context)),
    );
  };
  const newBrowserContext = async (
    contextOptions: Parameters<Browser["newContext"]>[0],
  ): Promise<BrowserContext> => {
    if (!browser) {
      throw new Error("Control UI E2E browser accessed before suite setup");
    }
    const context = await browser.newContext(contextOptions);
    // Harness owns the wait budget; per-test setDefaultTimeout sprinkles defeat CI scaling.
    context.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
    openBrowserContexts.add(context);
    return context;
  };

  return {
    get artifactDir() {
      return (artifactDir ??= createControlUiE2eArtifactDir(
        options.name.toLowerCase().replaceAll(/[^a-z0-9_-]+/gu, "-"),
      ));
    },
    get browser() {
      if (!browser) {
        throw new Error("Control UI E2E browser accessed before suite setup");
      }
      return browser;
    },
    get server() {
      if (!server) {
        throw new Error("Control UI E2E server accessed before suite setup");
      }
      return server;
    },
    closeBrowserContext,
    define(defineTests) {
      describeControlUiE2e(options.name, () => {
        // Each retry/repeat owns new proof, but disabled capture never reads the lazy directory.
        beforeEach(() => {
          artifactDir = undefined;
        });
        beforeAll(async () => {
          if (!chromiumAvailable && options.unavailableMessage) {
            throw new Error(options.unavailableMessage(chromiumExecutablePath));
          }
          const startServer = options.startServer ?? startControlUiE2eServer;
          if (options.startServerBeforeBrowser) {
            server = await startServer();
            browser = await chromium.launch({
              ...options.browserLaunchOptions,
              executablePath: chromiumExecutablePath,
            });
          } else {
            browser = await chromium.launch({
              ...options.browserLaunchOptions,
              executablePath: chromiumExecutablePath,
            });
            server = await startServer();
          }
        });

        afterAll(async () => {
          await runQaGatewayFixture(
            closeOpenBrowserContexts,
            () => browser?.close(),
            () => server?.close(),
          );
        });

        if (options.trackBrowserContexts) {
          afterEach(closeOpenBrowserContexts);
        }

        defineTests();
      });
    },
    newBrowserContext,
    async withPage<T>(
      contextOptions: Parameters<Browser["newContext"]>[0],
      run: (fixture: ControlUiE2ePage) => Promise<T>,
      cleanup?: (fixture: ControlUiE2ePage) => Promise<void>,
    ) {
      const context = await newBrowserContext(contextOptions);
      let result!: T;
      let fixture: ControlUiE2ePage | undefined;
      await runQaGatewayFixture(
        async () => {
          const page = await context.newPage();
          fixture = { context, page };
          try {
            result = await run(fixture);
          } catch (error) {
            // Keep closed-page diagnostics and capture other live documents before teardown.
            for (const diagnosticPage of new Set([page, ...context.pages()])) {
              await captureControlUiE2eFailureDiagnostics(diagnosticPage, {
                error: error instanceof Error ? error : new Error(String(error)),
                label: options.name,
              });
            }
            throw error;
          }
        },
        // Capture assertion diagnostics before a test closes its page or drains routes.
        () => (fixture ? cleanup?.(fixture) : undefined),
        () => closeBrowserContext(context),
      );
      return result;
    },
  };
}
