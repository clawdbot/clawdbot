// Mcp Client Temp State script supports OpenClaw repository automation.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type McpClientTempState = {
  cleanup: () => void;
  root: string;
  stateDir: string;
  tokenFile: string;
};

export type ReconnectableMcpClientHandle = {
  cleanup: () => void;
  client: { close: () => Promise<unknown> };
  transport: { close: () => Promise<unknown> };
};

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
