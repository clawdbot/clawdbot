import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, inject } from "vitest";
import {
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
  readonly browser: Browser;
  readonly server: ControlUiE2eServer;
  closeBrowserContext: (context: BrowserContext) => Promise<void>;
  define: (defineTests: () => void) => void;
  newBrowserContext: (options: Parameters<Browser["newContext"]>[0]) => Promise<BrowserContext>;
  withPage: <T>(
    options: Parameters<Browser["newContext"]>[0],
    run: (fixture: ControlUiE2ePage) => Promise<T>,
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

  const closeBrowserContext = async (context: BrowserContext): Promise<void> => {
    openBrowserContexts.delete(context);
    await context.close().catch(() => {});
  };
  const closeOpenBrowserContexts = async (): Promise<void> => {
    await Promise.all([...openBrowserContexts].map((context) => closeBrowserContext(context)));
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
        beforeAll(async () => {
          if (!chromiumAvailable && options.unavailableMessage) {
            throw new Error(options.unavailableMessage(chromiumExecutablePath));
          }
          const startServer = options.startServer ?? startControlUiE2eServer;
          if (options.startServerBeforeBrowser) {
            server = await startServer();
            try {
              browser = await chromium.launch({
                ...options.browserLaunchOptions,
                executablePath: chromiumExecutablePath,
              });
            } catch (error) {
              await server.close();
              throw error;
            }
          } else {
            browser = await chromium.launch({
              ...options.browserLaunchOptions,
              executablePath: chromiumExecutablePath,
            });
            try {
              server = await startServer();
            } catch (error) {
              await browser.close();
              throw error;
            }
          }
        });

        afterAll(async () => {
          await closeOpenBrowserContexts();
          await browser?.close();
          await server?.close();
        });

        if (options.trackBrowserContexts) {
          afterEach(closeOpenBrowserContexts);
        }

        defineTests();
      });
    },
    newBrowserContext,
    async withPage(contextOptions, run) {
      const context = await newBrowserContext(contextOptions);
      try {
        const page = await context.newPage();
        return await run({ context, page });
      } finally {
        await closeBrowserContext(context);
      }
    },
  };
}
