// Connects Chrome MCP transports and bounds handshake/readiness waits.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { toErrorObject } from "../infra/errors.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { redactCdpUrl } from "./cdp.helpers.js";
import {
  CHROME_MCP_HANDSHAKE_TIMEOUT_MS,
  type ChromeMcpSession,
  type NormalizedChromeMcpProfileOptions,
} from "./chrome-mcp-contracts.js";
import {
  drainStderr,
  redactChromeMcpDiagnosticTextWithLocalPaths,
  redactChromeMcpLocalPathForDiagnostic,
  redactChromeMcpProfileLabelForDiagnostic,
} from "./chrome-mcp-diagnostics.js";
import { buildChromeMcpArgsFromOptions, normalizeChromeMcpOptions } from "./chrome-mcp-options.js";
import {
  closeTrackedChromeMcpSession,
  refreshChromeMcpCleanupProcess,
} from "./chrome-mcp-process.js";
import { getChromeMcpSessionFactory } from "./chrome-mcp-state.js";
import { BrowserProfileUnavailableError } from "./errors.js";

const log = createSubsystemLogger("browser").child("chrome-mcp");

async function withChromeMcpHandshakeTimeout<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Chrome MCP handshake timed out"));
        }, CHROME_MCP_HANDSHAKE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function createRealSession(
  profileName: string,
  options: NormalizedChromeMcpProfileOptions = normalizeChromeMcpOptions(),
): Promise<ChromeMcpSession> {
  const transport = new StdioClientTransport({
    command: options.command,
    args: buildChromeMcpArgsFromOptions(options),
    stderr: "pipe",
  });
  const client = new Client(
    {
      name: "openclaw-browser",
      version: "0.0.0",
    },
    {},
  );
  let getStderr = () => "";
  const session: ChromeMcpSession = {
    client,
    transport,
    ready: Promise.resolve(),
    processCleanup: { status: "open" },
  };
  const requireSession = () => session;
  const ready = (async () => {
    try {
      await withChromeMcpHandshakeTimeout(
        (async () => {
          await client.connect(transport);
          await refreshChromeMcpCleanupProcess(requireSession());
          getStderr = drainStderr(transport);
          const tools = await client.listTools();
          if (!tools.tools.some((tool) => tool.name === "list_pages")) {
            throw new Error("Chrome MCP server did not expose the expected navigation tools.");
          }
          await refreshChromeMcpCleanupProcess(requireSession());
        })(),
      );
    } catch (err) {
      const stderr = getStderr();
      if (stderr) {
        log.warn(
          `Chrome MCP attach failed for profile "${redactChromeMcpProfileLabelForDiagnostic(profileName)}". Subprocess stderr:\n${redactChromeMcpDiagnosticTextWithLocalPaths(stderr)}`,
        );
      }
      const targetLabel = options.browserUrl
        ? `the configured Chrome endpoint (${redactToolPayloadText(redactCdpUrl(options.browserUrl) ?? options.browserUrl)})`
        : options.userDataDir
          ? `the configured Chromium user data dir (${redactChromeMcpLocalPathForDiagnostic(options.userDataDir)})`
          : "Google Chrome's default profile";
      const detail = redactChromeMcpDiagnosticTextWithLocalPaths(
        err instanceof Error ? err.message : String(err),
      );
      throw new BrowserProfileUnavailableError(
        `Chrome MCP existing-session attach failed for profile "${redactChromeMcpProfileLabelForDiagnostic(profileName)}". ` +
          `Make sure ${targetLabel} is running locally with remote debugging enabled. ` +
          `Details: ${detail}`,
      );
    }
  })();
  ready.catch(() => {});

  session.ready = ready;
  return session;
}

export async function waitForChromeMcpReady(
  session: ChromeMcpSession,
  profileName: string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }
  if ((!timeoutMs || timeoutMs <= 0) && !signal) {
    await session.ready;
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const racers: Array<Promise<void> | Promise<never>> = [session.ready];
    if (timeoutMs && timeoutMs > 0) {
      racers.push(
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new BrowserProfileUnavailableError(
                `Chrome MCP existing-session attach for profile "${redactChromeMcpProfileLabelForDiagnostic(profileName)}" timed out after ${timeoutMs}ms.`,
              ),
            );
          }, timeoutMs);
        }),
      );
    }
    if (signal) {
      racers.push(
        new Promise<never>((_, reject) => {
          abortListener = () =>
            reject(toErrorObject(signal.reason ?? new Error("aborted"), "Non-Error rejection"));
          signal.addEventListener("abort", abortListener, { once: true });
        }),
      );
    }
    await Promise.race(racers);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

export async function waitForChromeMcpPendingSession(
  pending: Promise<ChromeMcpSession>,
  signal?: AbortSignal,
): Promise<ChromeMcpSession> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }
  if (!signal) {
    return await pending;
  }

  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        abortListener = () =>
          reject(toErrorObject(signal.reason ?? new Error("aborted"), "Non-Error rejection"));
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

export function createChromeMcpSession(
  cacheKey: string,
  profileName: string,
  options: NormalizedChromeMcpProfileOptions,
  signal?: AbortSignal,
): { promise: Promise<ChromeMcpSession>; cleanup: Promise<void> } {
  const created = (getChromeMcpSessionFactory() ?? createRealSession)(profileName, options);
  let adopted = false;
  let closePromise: Promise<void> | undefined;
  const closeCreated = async (session: ChromeMcpSession) => {
    closePromise ??= closeTrackedChromeMcpSession(cacheKey, session);
    await closePromise;
  };
  const promise = (async () => {
    const session = await waitForChromeMcpPendingSession(created, signal);
    if (signal?.aborted) {
      await closeCreated(session);
      throw signal.reason ?? new Error("aborted");
    }
    adopted = true;
    return session;
  })();
  const cleanup = (async () => {
    await promise.catch(() => {});
    if (adopted) {
      return;
    }
    const session = await created.catch(() => null);
    if (session) {
      await closeCreated(session);
    }
  })();
  void cleanup.catch(() => {});
  return { promise, cleanup };
}
