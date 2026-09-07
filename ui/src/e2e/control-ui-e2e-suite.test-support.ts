import { writeSync } from "node:fs";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
} from "playwright";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  vi,
  type TestContext,
} from "vitest";
import { getActiveGatewayRootWorkCount } from "../../../src/process/gateway-work-admission.js";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
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
    controlUiE2eCleanup: { timeoutMs: number; pool: "forks"; isolate: true };
  }
}

type ControlUiE2eSuiteOptions = {
  browserLaunchOptions?: Omit<NonNullable<Parameters<typeof chromium.launch>[0]>, "executablePath">;
  name: string;
  resources?: ControlUiE2eScenario<void>;
  setupTimeoutMs?: number;
  teardownTimeoutMs?: number;
  startServer?: () => Promise<ControlUiE2eServer>;
  startServerBeforeBrowser?: boolean;
  trackBrowserContexts?: boolean;
  unavailableMessage?: (executablePath: string) => string;
};

type ControlUiE2ePage = { context: BrowserContext; page: Page };
type ControlUiE2eScenario<T> = {
  run: (signal: AbortSignal) => Promise<T>;
  close?: () => Promise<void>;
  release?: () => Promise<void>;
  retainedState?: () => string | undefined;
};
type ControlUiE2eSuite = {
  readonly artifactDir: string;
  readonly browser: Browser;
  readonly server: ControlUiE2eServer;
  closeBrowserContext: (context: BrowserContext) => Promise<void>;
  define: (defineTests: () => void) => void;
  newBrowserContext: (options: Parameters<Browser["newContext"]>[0]) => Promise<BrowserContext>;
  runScenario: <T>(context: TestContext, scenario: ControlUiE2eScenario<T>) => Promise<T>;
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

class ControlUiE2eAcquisitionClosedError extends Error {}

// A failed owner poisons this fork, including other suites in the same file.
// Native isolated-fork teardown owns termination; no fixture may restore state first.
let retiredForkError: Error | undefined;
function assertControlUiForkActive(): void {
  if (retiredForkError) {
    throw retiredForkError;
  }
}

function throwControlUiCleanupErrors(errors: unknown[]): void {
  if (errors.length > 0) {
    throw new AggregateError([...new Set(errors)], "Control UI E2E cleanup failed");
  }
}

async function settleControlUiCleanup(promises: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(promises);
  throwControlUiCleanupErrors(
    results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
  );
}

export function createControlUiE2eContextOptions(): BrowserContextOptions {
  return {
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  };
}

export function createControlUiE2eSuite(options: ControlUiE2eSuiteOptions): ControlUiE2eSuite {
  const { executablePath: chromiumExecutablePath, available: chromiumAvailable } =
    inject("controlUiE2eChromium");
  // Runner metadata crosses a process boundary; validate the injected runtime shape.
  const cleanupPolicy = asNullableRecord(inject("controlUiE2eCleanup"));
  if (
    !cleanupPolicy ||
    cleanupPolicy.pool !== "forks" ||
    cleanupPolicy.isolate !== true ||
    typeof process.send !== "function" ||
    typeof cleanupPolicy.timeoutMs !== "number" ||
    !Number.isFinite(cleanupPolicy.timeoutMs) ||
    cleanupPolicy.timeoutMs <= 0
  ) {
    throw new Error("Control UI E2E requires a Vitest fork with a finite cleanup deadline");
  }
  const cleanupTimeoutMs = cleanupPolicy.timeoutMs;
  const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
  const describeControlUiE2e =
    chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
  const openBrowserContexts = new Map<BrowserContext, AbortController | undefined>();
  const contextClosures = new WeakMap<BrowserContext, Promise<void>>();
  const contextAcquisitions = new Map<Promise<BrowserContext>, AbortController | undefined>();
  const acquisitionFailures: Array<{ owner: AbortController | undefined; error: unknown }> = [];
  const scenarios = new Set<Promise<unknown>>();
  const resourceLifetime = new AbortController();
  let activeScenario: AbortController | undefined;
  let unsafeCleanup: { error: unknown; retainedState: () => string | undefined } | undefined;
  let browser: Browser | undefined;
  let server: ControlUiE2eServer | undefined;
  let resources: ControlUiE2eScenario<void> | undefined;
  let artifactDir: string | undefined;
  let setupPromise: Promise<void> | undefined;
  let stopping = false;

  const retireFork = (error: unknown, retainedState?: () => string | undefined): Error => {
    if (!retiredForkError) {
      const detail =
        error instanceof AggregateError ? error.errors.map(String).join("; ") : String(error);
      const message = `[control-ui-e2e] unsafe cleanup: ${detail}; retained state: ${retainedState?.() ?? "not acquired"}; retiring owned fork`;
      retiredForkError = new Error(message, { cause: error });
      writeSync(2, `${message}\n`);
    }
    return retiredForkError;
  };
  const joinCleanup = async <T>(
    operation: Promise<T>,
    phase: string,
    retainedState?: () => string | undefined,
    timeoutMs = cleanupTimeoutMs,
  ): Promise<T> => {
    assertControlUiForkActive();
    const expired = createDeferredCore<never>();
    const deadline = setTimeout(
      () =>
        expired.reject(
          retireFork(new Error(`${phase} did not settle within ${timeoutMs}ms`), retainedState),
        ),
      timeoutMs,
    );
    try {
      return await Promise.race([operation, expired.promise]);
    } catch (error) {
      throw retireFork(error, retainedState);
    } finally {
      clearTimeout(deadline);
    }
  };

  const closeBrowserContext = (context: BrowserContext): Promise<void> => {
    let closing = contextClosures.get(context);
    if (!closing) {
      // Playwright's second close can return while the first is still finalizing.
      closing = Promise.resolve().then(async () => {
        await context.close();
        // Requests outlive sockets; pending handlers must release their admission
        // roots before fixture cleanup. waitFor also works in afterAll.
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0), {
          interval: 100,
          timeout: 15_000,
        });
        openBrowserContexts.delete(context);
      });
      contextClosures.set(context, closing);
    }
    return closing;
  };
  const closeOpenBrowserContexts = async (owner?: AbortController): Promise<void> => {
    const ownedContexts = () =>
      [...openBrowserContexts]
        .filter(([, scope]) => !owner || scope === owner)
        .map(([context]) => context);
    const early = Promise.allSettled(ownedContexts().map(closeBrowserContext));
    await Promise.allSettled(
      [...contextAcquisitions]
        .filter(([, scope]) => !owner || scope === owner)
        .map(([pending]) => pending),
    );
    const late = await Promise.allSettled(ownedContexts().map(closeBrowserContext));
    const failures = acquisitionFailures
      .filter((entry) => !owner || entry.owner === owner)
      .map((entry) => entry.error);
    for (const result of [...(await early), ...late]) {
      if (result.status === "rejected") {
        failures.push(result.reason);
      }
    }
    throwControlUiCleanupErrors(failures);
  };
  const newBrowserContext = (
    contextOptions: Parameters<Browser["newContext"]>[0],
  ): Promise<BrowserContext> => {
    assertControlUiForkActive();
    const currentBrowser = browser;
    const owner = activeScenario;
    if (!currentBrowser) {
      return Promise.reject(new Error("Control UI E2E browser accessed before suite setup"));
    }
    if (stopping || owner?.signal.aborted) {
      return Promise.reject(
        new ControlUiE2eAcquisitionClosedError("Control UI E2E context acquisition is closed"),
      );
    }
    const acquisition = Promise.resolve().then(async () => {
      const context = await currentBrowser.newContext(contextOptions);
      openBrowserContexts.set(context, owner);
      if (stopping || owner?.signal.aborted) {
        await closeBrowserContext(context);
        throw new ControlUiE2eAcquisitionClosedError(
          "Control UI E2E context arrived after teardown began",
        );
      }
      context.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      return context;
    });
    contextAcquisitions.set(acquisition, owner);
    void acquisition.then(
      () => contextAcquisitions.delete(acquisition),
      (error: unknown) => {
        contextAcquisitions.delete(acquisition);
        if (!(error instanceof ControlUiE2eAcquisitionClosedError)) {
          acquisitionFailures.push({ owner, error });
        }
      },
    );
    return acquisition;
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
    newBrowserContext,
    runScenario<T>(context: TestContext, scenario: ControlUiE2eScenario<T>): Promise<T> {
      assertControlUiForkActive();
      if (stopping || activeScenario) {
        throw new Error("A Control UI E2E scenario still owns the suite");
      }
      const owner = new AbortController();
      const operation = createDeferredCore<T>();
      const retainedState = scenario.retainedState ?? resources?.retainedState ?? (() => undefined);
      let cleanupComplete = false;
      activeScenario = owner;
      scenarios.add(operation.promise);
      const abort = () => {
        owner.abort(context.signal.reason);
        // Initiate cancellation now; finalization below joins these same closes.
        void closeOpenBrowserContexts(owner).catch(() => {});
      };
      context.signal.addEventListener("abort", abort, { once: true });
      if (context.signal.aborted) {
        abort();
      }
      // Native timeout rejects its wrapper, not the callback. On failed joining,
      // fence this file and retain state until native isolated-fork teardown exits.
      context.onTestFinished(() => {
        assertControlUiForkActive();
        const finished = operation.promise.then(
          () => undefined,
          (error: unknown) => {
            if (!cleanupComplete) {
              throw retireFork(error, retainedState);
            }
          },
        );
        return joinCleanup(finished, "scenario cleanup", retainedState);
      }, 0);
      operation.resolve(
        runQaGatewayFixture(
          async () => {
            owner.signal.throwIfAborted();
            return await scenario.run(owner.signal);
          },
          async () => {
            owner.abort();
            try {
              assertControlUiForkActive();
              await settleControlUiCleanup([
                closeOpenBrowserContexts(owner),
                Promise.resolve().then(scenario.close),
              ]);
              // A close can settle after the cleanup deadline retired this fork.
              assertControlUiForkActive();
              await scenario.release?.();
              cleanupComplete = true;
              activeScenario = undefined;
            } catch (error) {
              unsafeCleanup = { error, retainedState };
              throw error;
            }
          },
        ),
      );
      const settled = () => {
        scenarios.delete(operation.promise);
        context.signal.removeEventListener("abort", abort);
      };
      void operation.promise.then(settled, settled);
      return operation.promise;
    },
    define(defineTests) {
      describeControlUiE2e(options.name, () => {
        beforeEach(() => {
          assertControlUiForkActive();
          artifactDir = undefined;
        });
        beforeAll(() => {
          assertControlUiForkActive();
          if (!chromiumAvailable && options.unavailableMessage) {
            throw new Error(options.unavailableMessage(chromiumExecutablePath));
          }
          const startServer = options.startServer ?? startControlUiE2eServer;
          setupPromise = Promise.resolve().then(async () => {
            if (options.startServerBeforeBrowser) {
              server = await startServer();
              if (stopping) {
                return;
              }
              browser = await chromium.launch({
                ...options.browserLaunchOptions,
                executablePath: chromiumExecutablePath,
              });
            } else {
              browser = await chromium.launch({
                ...options.browserLaunchOptions,
                executablePath: chromiumExecutablePath,
              });
              if (stopping) {
                return;
              }
              server = await startServer();
            }
            if (!stopping) {
              // Only an owner whose acquisition began may receive cleanup callbacks.
              resources = options.resources;
              await resources?.run(resourceLifetime.signal);
            }
          });
          return setupPromise;
        }, options.setupTimeoutMs);
        afterAll(() => {
          assertControlUiForkActive();
          stopping = true;
          resourceLifetime.abort();
          activeScenario?.abort();
          const closingContexts = closeOpenBrowserContexts();
          const contexts = Promise.allSettled([closingContexts]);
          const teardown = (async () => {
            const [setup] = await Promise.allSettled([setupPromise]);
            await Promise.allSettled(scenarios);
            const errors: unknown[] = setup.status === "rejected" ? [setup.reason] : [];
            for (const result of await contexts) {
              if (result.status === "rejected") {
                errors.push(result.reason);
              }
            }
            for (const close of [
              () => browser?.close(),
              () => resources?.close?.(),
              () => server?.close(),
            ]) {
              try {
                await close();
              } catch (error) {
                errors.push(error);
              }
            }
            if (unsafeCleanup) {
              throw retireFork(unsafeCleanup.error, unsafeCleanup.retainedState);
            }
            throwControlUiCleanupErrors(errors);
            assertControlUiForkActive();
            await resources?.release?.();
          })();
          return joinCleanup(
            teardown,
            "suite teardown",
            resources?.retainedState ?? unsafeCleanup?.retainedState,
            options.teardownTimeoutMs,
          );
        }, 0);
        if (options.trackBrowserContexts) {
          afterEach(() => {
            assertControlUiForkActive();
            return joinCleanup(closeOpenBrowserContexts(), "browser context cleanup");
          }, 0);
        }
        defineTests();
      });
    },
    async withPage(contextOptions, run, cleanup) {
      const context = await newBrowserContext(contextOptions);
      let fixture: ControlUiE2ePage | undefined;
      return await runQaGatewayFixture(
        async () => {
          const page = await context.newPage();
          fixture = { context, page };
          try {
            return await run(fixture);
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
    },
  };
}
