import type { MatrixClient } from "@vector-im/matrix-bot-sdk";

import { getMatrixRuntime } from "../../runtime.js";
import { getActiveMatrixClient } from "../active-client.js";
import {
  createMatrixClient,
  isBunRuntime,
  resolveMatrixAuth,
  resolveSharedMatrixClient,
} from "../client.js";
import type { CoreConfig } from "../types.js";

const getCore = () => getMatrixRuntime();

export function ensureNodeRuntime() {
  if (isBunRuntime()) {
    throw new Error("Matrix support requires Node (bun runtime not supported)");
  }
}

export function resolveMediaMaxBytes(): number | undefined {
  const cfg = getCore().config.loadConfig() as CoreConfig;
  if (typeof cfg.channels?.matrix?.mediaMaxMb === "number") {
    return cfg.channels.matrix.mediaMaxMb * 1024 * 1024;
  }
  return undefined;
}

export async function resolveMatrixClient(opts: {
  client?: MatrixClient;
  timeoutMs?: number;
}): Promise<{ client: MatrixClient; stopOnDone: boolean }> {
  ensureNodeRuntime();
  if (opts.client) return { client: opts.client, stopOnDone: false };
  const active = getActiveMatrixClient();
  if (active) return { client: active, stopOnDone: false };
  const shouldShareClient = Boolean(process.env.CLAWDBOT_GATEWAY_PORT);
  if (shouldShareClient) {
    const client = await resolveSharedMatrixClient({
      timeoutMs: opts.timeoutMs,
    });
    return { client, stopOnDone: false };
  }
  const auth = await resolveMatrixAuth();
  const client = await createMatrixClient({
    homeserver: auth.homeserver,
    userId: auth.userId,
    accessToken: auth.accessToken,
    encryption: auth.encryption,
    localTimeoutMs: opts.timeoutMs,
  });
  if (auth.encryption && client.crypto) {
    try {
      const joinedRooms = await client.getJoinedRooms();
      await client.crypto.prepare(joinedRooms);
    } catch {
      // Ignore crypto prep failures for one-off sends; normal sync will retry.
    }
  }
  // @vector-im/matrix-bot-sdk uses start() instead of startClient()
  await client.start();
  return { client, stopOnDone: true };
}
