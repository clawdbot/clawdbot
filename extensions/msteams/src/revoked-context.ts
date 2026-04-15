import { isRevokedProxyError } from "./errors.js";

export async function withRevokedProxyFallback<T>(params: {
  run: () => Promise<T>;
  onRevoked: () => Promise<T>;
  onRevokedLog?: () => void;
}): Promise<T> {
  try {
    return await params.run();
  } catch (err) {
    if (!isRevokedProxyError(err)) {
      throw err;
    }
    params.onRevokedLog?.();
    return await params.onRevoked();
  }
}
