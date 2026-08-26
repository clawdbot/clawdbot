import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { OpenClawStreamableHTTPClientTransport } from "./mcp-http-transport.js";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";

type LifecycleSession = {
  client: Pick<Client, "close">;
  transport: Transport & { terminateSession?: () => Promise<void> };
  transportType: "stdio" | "sse" | "streamable-http";
  detachStderr?: () => void;
};

export class McpClientConnectTimeoutError extends Error {}

/** Matches the SDK's terminal signal for an expired stateful Streamable HTTP session. */
export function isStatefulMcpHttpSessionExpired(
  session: Pick<LifecycleSession, "transport" | "transportType">,
  error: unknown,
): boolean {
  return (
    session.transportType === "streamable-http" &&
    session.transport instanceof OpenClawStreamableHTTPClientTransport &&
    session.transport.sessionId !== undefined &&
    error instanceof StreamableHTTPError &&
    error.code === 404
  );
}

export async function connectMcpClient(params: {
  client: Pick<Client, "connect" | "close">;
  transport: Transport;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  const deadline = AbortSignal.timeout(params.timeoutMs);
  const signal = params.signal ? AbortSignal.any([params.signal, deadline]) : deadline;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error("MCP startup aborted"));
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    await Promise.race([
      params.client.connect(params.transport, {
        signal,
        timeout: params.timeoutMs,
        maxTotalTimeout: params.timeoutMs,
      }),
      aborted,
    ]);
  } catch (error) {
    if (deadline.aborted || (isRecord(error) && error.code === ErrorCode.RequestTimeout)) {
      await disposeMcpClient(
        {
          client: params.client,
          transport: params.transport,
          transportType:
            params.transport instanceof OpenClawStdioClientTransport
              ? "stdio"
              : params.transport instanceof OpenClawStreamableHTTPClientTransport
                ? "streamable-http"
                : "sse",
        },
        Math.min(params.timeoutMs, 1_000),
      );
      throw new McpClientConnectTimeoutError(
        `MCP server connection timed out after ${params.timeoutMs}ms`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function ignoreCloseFailure(close: () => void | PromiseLike<unknown>): Promise<void> {
  try {
    await close();
  } catch {
    // Disposal is best-effort, but each later close step must still run.
  }
}

export async function disposeMcpClient(
  session: LifecycleSession,
  timeoutMs = 5_000,
): Promise<void> {
  session.detachStderr?.();
  const closed = await settleWithin(
    (async () => {
      if (session.transportType === "streamable-http") {
        await ignoreCloseFailure(() => session.transport.terminateSession?.());
      }
      await ignoreCloseFailure(() => session.transport.close());
      await ignoreCloseFailure(() => session.client.close());
    })(),
    timeoutMs,
  );
  if (closed) {
    return;
  }

  // Closing an HTTP transport aborts a hung DELETE. Stdio owns a process
  // group, so force it dead before disposal can report completion.
  const { transport } = session;
  const closeTransport =
    session.transportType === "stdio" && transport instanceof OpenClawStdioClientTransport
      ? () => transport.forceClose()
      : () => transport.close();
  await settleWithin(
    Promise.all([
      ignoreCloseFailure(closeTransport),
      ignoreCloseFailure(() => session.client.close()),
    ]),
    timeoutMs,
  );
}
