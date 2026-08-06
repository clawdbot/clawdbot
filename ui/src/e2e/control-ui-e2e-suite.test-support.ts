import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, afterEach, beforeAll, describe } from "vitest";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

type ControlUiE2eSuiteOptions = {
  name: string;
  unavailableMessage: (executablePath: string) => string;
  trackBrowserContexts?: boolean;
};

type ControlUiE2eSuite = {
  readonly browser: Browser;
  readonly server: ControlUiE2eServer;
  closeBrowserContext: (context: BrowserContext) => Promise<void>;
  define: (defineTests: () => void) => void;
  newBrowserContext: (options: Parameters<Browser["newContext"]>[0]) => Promise<BrowserContext>;
};

export function createControlUiE2eSuite(options: ControlUiE2eSuiteOptions): ControlUiE2eSuite {
  const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
  const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
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
          if (!chromiumAvailable) {
            throw new Error(options.unavailableMessage(chromiumExecutablePath));
          }
          browser = await chromium.launch({ executablePath: chromiumExecutablePath });
          try {
            server = await startControlUiE2eServer();
          } catch (error) {
            await browser.close();
            throw error;
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
    async newBrowserContext(contextOptions) {
      if (!browser) {
        throw new Error("Control UI E2E browser accessed before suite setup");
      }
      const context = await browser.newContext(contextOptions);
      openBrowserContexts.add(context);
      return context;
    },
  };
}
