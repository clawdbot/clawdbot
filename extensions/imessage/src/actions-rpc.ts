import { createIMessageRpcClient } from "./client.js";

export type IMessageActionTransportOptions = {
  cliPath: string;
  dbPath?: string;
  remoteHost?: string;
  timeoutMs?: number;
};

class IMessageRemoteUnsupportedError extends Error {
  readonly code = "IMESSAGE_REMOTE_UNSUPPORTED";

  constructor(message: string) {
    super(message);
    this.name = "IMessageRemoteUnsupportedError";
  }
}

export function throwIMessageRemoteUnsupported(message: string): never {
  throw new IMessageRemoteUnsupportedError(`iMessage Remote Mac limitation: ${message}`);
}

export async function requestIMessageActionRpc<T extends Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
  options: IMessageActionTransportOptions,
): Promise<T> {
  const client = await createIMessageRpcClient({
    cliPath: options.cliPath,
    dbPath: options.dbPath,
    remoteHost: options.remoteHost,
  });
  try {
    return await client.request<T>(method, params, { timeoutMs: options.timeoutMs });
  } finally {
    await client.stop();
  }
}
