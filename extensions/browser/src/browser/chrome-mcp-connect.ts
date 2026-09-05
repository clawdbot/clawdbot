// Connects Chrome MCP transports and bounds handshake/readiness waits.
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
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
  cacheKey: string,
  profileName: string,
  options: NormalizedChromeMcpProfileOptions,
): Promise<ChromeMcpSession> {
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args,
    stderr: "pipe",
  });
  const client = new Client(
    {
      name: "openclaw-browser",
      version: "0.0.0",
    },
    {},
  );
  // Capture before connect starts the subprocess so failed handshakes retain stderr.
  const getStderr = drainStderr(transport);
  const startTransport = transport.start.bind(transport);
  let spawned = false;
  const session: ChromeMcpSession = {
    client,
    transport,
    closeTransport: transport.close.bind(transport),
    ready: Promise.resolve(),
    processCleanup: { status: "open" },
  };
  transport.start = async () => {
    await startTransport();
    // Spawn success owns the stderr lifetime; close may already have cleared the PID.
    spawned = true;
    await refreshChromeMcpCleanupProcess(session);
  };
  // SDK initialization and read-buffer failures can close before connect settles.
  // Funnel both SDK entry points through the same owner before it clears the PID.
  client.close = transport.close = () => closeTrackedChromeMcpSession(cacheKey, session);
  const ready = (async () => {
    try {
      await withChromeMcpHandshakeTimeout(
        (async () => {
          await client.connect(transport);
          const tools = await client.listTools();
          if (!tools.tools.some((tool) => tool.name === "list_pages")) {
            throw new Error("Chrome MCP server did not expose the expected navigation tools.");
          }
          await refreshChromeMcpCleanupProcess(session);
        })(),
      );
    } catch (err) {
      try {
        await transport.close();
        // The SDK's final SIGKILL can return before stdio closes. Tree cleanup
        // must finish first, since descendants may still hold this pipe open.
        const stderr = transport.stderr;
        if (spawned && stderr instanceof Readable) {
          await finished(stderr, { readable: true, writable: false, cleanup: true });
        }
      } finally {
        const stderr = getStderr();
        if (stderr) {
          log.warn(
            `Chrome MCP attach failed for profile "${redactChromeMcpProfileLabelForDiagnostic(profileName)}". Subprocess stderr:\n${redactChromeMcpDiagnosticTextWithLocalPaths(stderr)}`,
          );
        }
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
  const factory = getChromeMcpSessionFactory();
  const created = factory
    ? factory(profileName, options)
    : createRealSession(cacheKey, profileName, options);
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
