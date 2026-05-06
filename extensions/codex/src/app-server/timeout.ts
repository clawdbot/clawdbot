import { withTimeout as withSharedTimeout } from "openclaw/plugin-sdk/security-runtime";

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return await withSharedTimeout(promise, timeoutMs, { message: timeoutMessage });
}
