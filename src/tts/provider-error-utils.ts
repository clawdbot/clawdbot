export { asFiniteNumber } from "../shared/number-coercion.js";
import { normalizeOptionalString as trimToUndefined } from "../shared/string-coerce.js";
export { normalizeOptionalString as trimToUndefined } from "../shared/string-coerce.js";

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function truncateErrorDetail(detail: string, limit = 220): string {
  return detail.length <= limit ? detail : `${detail.slice(0, limit - 1)}…`;
}

export async function readResponseTextLimited(
  response: Response,
  limitBytes = 16 * 1024,
): Promise<string> {
  if (limitBytes <= 0) {
    return "";
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }

  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  let reachedLimit = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      const remaining = limitBytes - total;
      if (remaining <= 0) {
        reachedLimit = true;
        break;
      }
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      total += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (total >= limitBytes) {
        reachedLimit = true;
        break;
      }
    }
    text += decoder.decode();
  } finally {
    if (reachedLimit) {
      await reader.cancel().catch(() => {});
    }
  }

  return text;
}

export function formatProviderErrorPayload(payload: unknown): string | undefined {
  const root = asObject(payload);
  const subject = asObject(root?.error) ?? root;
  if (!subject) {
    return undefined;
  }
  const message =
    trimToUndefined(subject.message) ??
    trimToUndefined(subject.detail) ??
    trimToUndefined(root?.message);
  const type = trimToUndefined(subject.type);
  const code = trimToUndefined(subject.code);
  const metadata = [type ? `type=${type}` : undefined, code ? `code=${code}` : undefined]
    .filter((value): value is string => Boolean(value))
    .join(", ");
  if (message && metadata) {
    return `${truncateErrorDetail(message)} [${metadata}]`;
  }
  if (message) {
    return truncateErrorDetail(message);
  }
  if (metadata) {
    return `[${metadata}]`;
  }
  return undefined;
}

export async function extractProviderErrorDetail(response: Response): Promise<string | undefined> {
  const rawBody = trimToUndefined(await readResponseTextLimited(response));
  if (!rawBody) {
    return undefined;
  }
  try {
    return formatProviderErrorPayload(JSON.parse(rawBody)) ?? truncateErrorDetail(rawBody);
  } catch {
    return truncateErrorDetail(rawBody);
  }
}
