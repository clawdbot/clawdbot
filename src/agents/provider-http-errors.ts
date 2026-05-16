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
  const detailObject = asObject(root?.detail);
  const subject = asObject(root?.error) ?? detailObject ?? root;
  if (!subject) {
    return undefined;
  }
  const message =
    trimToUndefined(subject.message) ??
    trimToUndefined(subject.detail) ??
    trimToUndefined(root?.message) ??
    trimToUndefined(root?.error) ??
    trimToUndefined(root?.detail);
  const type = trimToUndefined(subject.type);
  const code = trimToUndefined(subject.code) ?? trimToUndefined(subject.status);
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

export function extractProviderRequestId(response: Response): string | undefined {
  return (
    trimToUndefined(response.headers.get("x-request-id")) ??
    trimToUndefined(response.headers.get("request-id"))
  );
}

export function formatProviderHttpErrorMessage(params: {
  label: string;
  status: number;
  detail?: string;
  requestId?: string;
  statusPrefix?: string;
}): string {
  const { label, status, detail, requestId, statusPrefix = "" } = params;
  return (
    `${label} (${statusPrefix}${status})` +
    (detail ? `: ${detail}` : "") +
    (requestId ? ` [request_id=${requestId}]` : "")
  );
}

export async function createProviderHttpError(
  response: Response,
  label: string,
  options?: { statusPrefix?: string },
): Promise<Error> {
  const detail = await extractProviderErrorDetail(response);
  const requestId = extractProviderRequestId(response);
  return new Error(
    formatProviderHttpErrorMessage({
      label,
      status: response.status,
      detail,
      requestId,
      statusPrefix: options?.statusPrefix,
    }),
  );
}

export async function assertOkOrThrowProviderError(
  response: Response,
  label: string,
): Promise<void> {
  if (response.ok) {
    return;
  }
  throw await createProviderHttpError(response, label);
}

export async function assertOkOrThrowHttpError(response: Response, label: string): Promise<void> {
  if (response.ok) {
    return;
  }
  throw await createProviderHttpError(response, label, { statusPrefix: "HTTP " });
}

export async function readProviderJsonResponse<T>(response: Response, label: string): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (cause) {
    throw new Error(`${label}: malformed JSON response`, { cause });
  }
}

export async function readProviderJsonObjectResponse(
  response: Response,
  label: string,
): Promise<Record<string, unknown>> {
  const payload = await readProviderJsonResponse<unknown>(response, label);
  const object = asObject(payload);
  if (!object) {
    throw new Error(`${label}: malformed JSON response`);
  }
  return object;
}

export async function readProviderJsonArrayFieldResponse(
  response: Response,
  label: string,
  field: string,
): Promise<unknown[]> {
  const payload = await readProviderJsonObjectResponse(response, label);
  const value = payload[field];
  if (!Array.isArray(value)) {
    throw new Error(`${label}: malformed JSON response`);
  }
  return value;
}

function normalizeContentType(response: Response): string | undefined {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  return contentType || undefined;
}

export function assertProviderBinaryResponseContent(
  response: Response,
  label: string,
  kind = "binary",
): void {
  const contentType = normalizeContentType(response);
  if (!contentType) {
    return;
  }
  if (
    contentType === "application/json" ||
    contentType.endsWith("+json") ||
    contentType.startsWith("text/")
  ) {
    throw new Error(`${label}: malformed ${kind} response`);
  }
}

export async function readProviderBinaryResponse(
  response: Response,
  label: string,
  kind = "binary",
): Promise<Uint8Array> {
  assertProviderBinaryResponseContent(response, label, kind);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`${label}: malformed ${kind} response`);
  }
  return bytes;
}
