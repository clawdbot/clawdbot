// MCP client temp-state helpers used by QA-owned MCP E2E fixtures.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type McpClientTempState = {
  cleanup: () => void;
  root: string;
  stateDir: string;
  tokenFile: string;
};

type ReconnectableMcpClientHandle = {
  cleanup: () => void;
  client: { close: () => Promise<unknown> };
  transport: { close: () => Promise<unknown> };
};

type McpConnectTransport = {
  close?(): Promise<void> | void;
};

const MCP_TIMEOUT_CLOSE_GRACE_MS = 5_000;

export function createMcpClientTempState(params: {
  gatewayToken: string;
  tempRoot?: string;
}): McpClientTempState {
  const root = mkdtempSync(path.join(params.tempRoot ?? tmpdir(), "openclaw-mcp-client-"));
  const stateDir = path.join(root, "state");
  const tokenFile = path.join(root, "gateway.token");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(tokenFile, `${params.gatewayToken}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    cleanup: () => {
      rmSync(root, { force: true, recursive: true });
    },
    root,
    stateDir,
    tokenFile,
  };
}

export async function connectMcpWithTimeout<TTransport extends McpConnectTransport>(
  client: { connect(transport: TTransport): Promise<void> },
  transport: TTransport,
  timeoutMs: number,
): Promise<void> {
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      reject(new Error(`MCP stdio connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    await Promise.race([client.connect(transport), timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      await closeTimedOutTransport(transport);
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function closeTimedOutTransport(transport: McpConnectTransport): Promise<void> {
  if (!transport.close) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve(transport.close()).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, MCP_TIMEOUT_CLOSE_GRACE_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function connectMcpClientWithPairingReconnect<
  T extends ReconnectableMcpClientHandle,
>(params: {
  connect: (tempState: McpClientTempState) => Promise<T>;
  maybeApprovePairing: () => Promise<boolean>;
  tempState: McpClientTempState;
}): Promise<T> {
  let handle = await params.connect(params.tempState);
  let shouldReconnect: boolean;
  try {
    shouldReconnect = await params.maybeApprovePairing();
  } catch (error) {
    await Promise.allSettled([handle.client.close(), handle.transport.close()]);
    handle.cleanup();
    throw error;
  }
  if (!shouldReconnect) {
    return handle;
  }
  await Promise.allSettled([handle.client.close(), handle.transport.close()]);
  handle.cleanup();
  handle = await params.connect(params.tempState);
  return handle;
}
