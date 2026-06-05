/**
 * Agent-contract test harness for starting the Browser control server and
 * posting JSON through a real fetch implementation.
 */
import {
  getBrowserControlServerBaseUrl,
  installBrowserControlServerHooks,
  startBrowserControlServerFromConfig,
} from "./server.control-server.test-harness.js";
import { getBrowserTestFetch } from "./test-support/fetch.js";

/** Installs Browser control-server hooks for agent-contract tests. */
export function installAgentContractHooks() {
  installBrowserControlServerHooks();
}

function isTransientStartupFetchError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: unknown; cause?: unknown };
  if (record.code === "ECONNRESET" || record.code === "ECONNREFUSED") {
    return true;
  }
  return isTransientStartupFetchError(record.cause);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function postStartWithRetry(params: {
  fetch: ReturnType<typeof getBrowserTestFetch>;
  url: string;
}): Promise<void> {
  const delaysMs = [0, 25, 50, 100, 200] as const;
  let lastError: unknown;
  for (const delayMs of delaysMs) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    try {
      const response = await params.fetch(params.url, { method: "POST" });
      await response.json();
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientStartupFetchError(error)) {
        throw error;
      }
    }
  }
  throw lastError;
}

/** Starts the Browser control server and returns its base URL. */
export async function startServerAndBase(): Promise<string> {
  await startBrowserControlServerFromConfig();
  const base = getBrowserControlServerBaseUrl();
  const realFetch = getBrowserTestFetch();
  await postStartWithRetry({ fetch: realFetch, url: `${base}/start` });
  return base;
}

/** Posts JSON to a Browser control-server route and parses the JSON response. */
export async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const realFetch = getBrowserTestFetch();
  const res = await realFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
}
