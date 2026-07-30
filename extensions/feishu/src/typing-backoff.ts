/** Feishu API codes that should trip the typing circuit breaker. */
const FEISHU_BACKOFF_CODES = new Set([99991400, 99991403, 429]);

export class FeishuBackoffError extends Error {
  code: number;

  constructor(code: number) {
    super(`Feishu API backoff: code ${code}`);
    this.name = "FeishuBackoffError";
    this.code = code;
  }
}

export function isFeishuBackoffError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }

  const response = (err as { response?: { status?: number; data?: { code?: number } } }).response;
  if (response) {
    if (response.status === 429) {
      return true;
    }
    if (typeof response.data?.code === "number" && FEISHU_BACKOFF_CODES.has(response.data.code)) {
      return true;
    }
  }

  const code = (err as { code?: number }).code;
  return typeof code === "number" && FEISHU_BACKOFF_CODES.has(code);
}

export function getBackoffCodeFromResponse(response: unknown): number | undefined {
  if (typeof response !== "object" || response === null) {
    return undefined;
  }
  const code = (response as { code?: number }).code;
  return typeof code === "number" && FEISHU_BACKOFF_CODES.has(code) ? code : undefined;
}
