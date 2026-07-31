import { spawnSync } from "node:child_process";
// Qa Lab plugin module implements web runtime behavior.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolvePositiveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

type QaWebSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  diagnostics: QaWebDiagnosticEntry[];
};

type QaWebDiagnosticEntry = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

type QaWebOpenPageParams = {
  url: string;
  headless?: boolean;
  channel?: "chrome";
  repoRoot?: string;
  timeoutMs?: number;
  viewport?: { width: number; height: number };
};

type QaWebWaitParams = {
  pageId: string;
  selector?: string;
  text?: string;
  timeoutMs?: number;
};

type QaWebTypeParams = {
  pageId: string;
  selector: string;
  text: string;
  submit?: boolean;
  timeoutMs?: number;
};

type QaWebSnapshotParams = {
  pageId: string;
  timeoutMs?: number;
  maxChars?: number;
};

type QaWebEvaluateParams = {
  pageId: string;
  expression: string;
  timeoutMs?: number;
};

const sessions = new Map<string, QaWebSession>();
const DEFAULT_WEB_TIMEOUT_MS = 20_000;
const MAX_DIAGNOSTIC_ENTRIES = 50;
const MAX_DIAGNOSTIC_TEXT_CHARS = 2_000;
const PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH_ENV = "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH";
const SYSTEM_CHROMIUM_EXECUTABLE_CANDIDATES = [
  "/snap/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
] as const;

function appendDiagnostic(diagnostics: QaWebDiagnosticEntry[], entry: QaWebDiagnosticEntry): void {
  diagnostics.push({
    kind: entry.kind,
    text: truncateUtf16Safe(entry.text, MAX_DIAGNOSTIC_TEXT_CHARS),
  });
  if (diagnostics.length > MAX_DIAGNOSTIC_ENTRIES) {
    diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTIC_ENTRIES);
  }
}

function resolveTimeoutMs(timeoutMs: number | undefined, fallbackMs = DEFAULT_WEB_TIMEOUT_MS) {
  return resolvePositiveTimerTimeoutMs(timeoutMs, fallbackMs);
}

function resolveSession(pageId: string): QaWebSession {
  const session = sessions.get(pageId);
  if (!session) {
    throw new Error(`unknown web session: ${pageId}`);
  }
  return session;
}

function canRunChromiumExecutable(executablePath: string): boolean {
  const result = spawnSync(executablePath, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function resolveRunnableChromiumExecutablePath(): string | undefined {
  const executableOverride = process.env[PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH_ENV]?.trim();
  if (executableOverride) {
    return existsSync(executableOverride) && canRunChromiumExecutable(executableOverride)
      ? executableOverride
      : undefined;
  }
  return SYSTEM_CHROMIUM_EXECUTABLE_CANDIDATES.find(
    (candidate) => existsSync(candidate) && canRunChromiumExecutable(candidate),
  );
}

function ensureChromiumAvailable(repoRoot: string) {
  const result = spawnSync(
    process.execPath,
    ["scripts/ensure-playwright-chromium.mjs", "--skip-ffmpeg"],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    },
  );
  if ((result.status ?? 1) !== 0) {
    throw new Error(`failed to ensure Playwright Chromium; status=${result.status ?? "unknown"}`);
  }
}

function buildChromiumLaunchOptions(params: QaWebOpenPageParams) {
  const baseOptions = {
    headless: params.headless ?? true,
  };
  if (params.channel) {
    return {
      ...baseOptions,
      channel: params.channel,
    };
  }
  const executablePath = resolveRunnableChromiumExecutablePath();
  return executablePath
    ? {
        ...baseOptions,
        executablePath,
      }
    : baseOptions;
}

export async function qaWebOpenPage(params: QaWebOpenPageParams) {
  const timeoutMs = resolveTimeoutMs(params.timeoutMs);
  if (!params.channel) {
    ensureChromiumAvailable(params.repoRoot ?? process.cwd());
  }
  const browser = await chromium.launch(buildChromiumLaunchOptions(params));
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: params.viewport ?? { width: 1440, height: 1080 },
  });
  const page = await context.newPage();
  const diagnostics: QaWebDiagnosticEntry[] = [];
  page.on("console", (message) => {
    appendDiagnostic(diagnostics, {
      kind: "console",
      text: `[${message.type()}] ${message.text()}`,
    });
  });
  page.on("pageerror", (error) => {
    appendDiagnostic(diagnostics, {
      kind: "pageerror",
      text: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  });
  page.on("requestfailed", (request) => {
    appendDiagnostic(diagnostics, {
      kind: "requestfailed",
      text: `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
    });
  });
  await page.goto(params.url, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  const pageId = randomUUID();
  sessions.set(pageId, { browser, context, page, diagnostics });
  return {
    pageId,
    url: page.url(),
    title: await page.title().catch(() => ""),
  };
}

export async function qaWebWait(params: QaWebWaitParams) {
  const session = resolveSession(params.pageId);
  const timeoutMs = resolveTimeoutMs(params.timeoutMs);
  if (params.selector) {
    await session.page.waitForSelector(params.selector, { timeout: timeoutMs });
    return { ok: true };
  }
  if (params.text) {
    await session.page.waitForFunction(
      (expected) => document.body?.textContent?.toLowerCase().includes(expected.toLowerCase()),
      params.text,
      { timeout: timeoutMs },
    );
    return { ok: true };
  }
  throw new Error("web wait requires selector or text");
}

export async function qaWebType(params: QaWebTypeParams) {
  const session = resolveSession(params.pageId);
  const timeoutMs = resolveTimeoutMs(params.timeoutMs);
  const locator = session.page.locator(params.selector).first();
  await locator.waitFor({ timeout: timeoutMs });
  await locator.fill(params.text, { timeout: timeoutMs });
  if (params.submit) {
    await locator.press("Enter", { timeout: timeoutMs });
  }
  return { ok: true };
}

export async function qaWebSnapshot(params: QaWebSnapshotParams) {
  const session = resolveSession(params.pageId);
  const timeoutMs = resolveTimeoutMs(params.timeoutMs);
  const body = session.page.locator("body");
  await body.waitFor({ timeout: timeoutMs });
  const text = (await body.textContent({ timeout: timeoutMs })) ?? "";
  const maxChars =
    typeof params.maxChars === "number" && Number.isFinite(params.maxChars)
      ? Math.max(1, Math.floor(params.maxChars))
      : undefined;
  return {
    url: session.page.url(),
    title: await session.page.title().catch(() => ""),
    text: maxChars ? truncateUtf16Safe(text, maxChars) : text,
    diagnostics: [...session.diagnostics],
  };
}

export async function qaWebEvaluate<T = unknown>(params: QaWebEvaluateParams): Promise<T> {
  const session = resolveSession(params.pageId);
  const timeoutMs = resolveTimeoutMs(params.timeoutMs);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return (await Promise.race([
      session.page.evaluate(({ expression }) => (0, eval)(expression) as unknown, {
        expression: params.expression,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`web evaluate timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ])) as T;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function closeQaWebSessions(pageIds?: Iterable<string>): Promise<void> {
  const active = pageIds
    ? [...pageIds].flatMap((pageId) => {
        const session = sessions.get(pageId);
        sessions.delete(pageId);
        return session ? [session] : [];
      })
    : [...sessions.values()];
  if (!pageIds) {
    sessions.clear();
  }
  for (const session of active) {
    await session.context.close().catch(() => {});
    await session.browser.close().catch(() => {});
  }
}
