export { asFiniteNumber } from "../shared/number-coercion.js";
import { redactSensitiveText } from "../logging/redact.js";
import { normalizeOptionalString as trimToUndefined } from "../shared/string-coerce.js";
export { normalizeOptionalString as trimToUndefined } from "../shared/string-coerce.js";

const ERROR_BODY_METADATA_LIMIT = 500;

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

export function redactProviderErrorBody(body: string): string {
  return truncateErrorDetail(redactSensitiveText(body), ERROR_BODY_METADATA_LIMIT);
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

type ProviderErrorPayloadMetadata = {
  detail?: string;
  code?: string;
  type?: string;
};

function extractProviderErrorPayloadMetadata(payload: unknown): ProviderErrorPayloadMetadata {
  const root = asObject(payload);
  const detailObject = asObject(root?.detail);
  const subject = asObject(root?.error) ?? detailObject ?? root;
  if (!subject) {
    return {};
  }

  const detail = formatProviderErrorPayload(payload);
  const type = trimToUndefined(subject.type);
  const code = trimToUndefined(subject.code) ?? trimToUndefined(subject.status);
  return {
    ...(detail ? { detail: redactSensitiveText(detail) } : {}),
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
  };
}

export type ProviderHttpErrorInfo = {
  detail?: string;
  code?: string;
  type?: string;
  body?: string;
  requestId?: string;
};

export async function extractProviderErrorInfo(response: Response): Promise<ProviderHttpErrorInfo> {
  const rawBody = trimToUndefined(await readResponseTextLimited(response));
  const requestId = extractProviderRequestId(response);
  if (!rawBody) {
    return requestId ? { requestId } : {};
  }
  const body = redactProviderErrorBody(rawBody);
  try {
    const metadata = extractProviderErrorPayloadMetadata(JSON.parse(rawBody));
    return {
      ...(metadata.detail ? { detail: metadata.detail } : { detail: body }),
      ...(metadata.code ? { code: metadata.code } : {}),
      ...(metadata.type ? { type: metadata.type } : {}),
      body,
      ...(requestId ? { requestId } : {}),
    };
  } catch {
    return {
      detail: body,
      body,
      ...(requestId ? { requestId } : {}),
    };
  }
}

export async function extractProviderErrorDetail(response: Response): Promise<string | undefined> {
  return (await extractProviderErrorInfo(response)).detail;
}

export function extractProviderRequestId(response: Response): string | undefined {
  return (
    trimToUndefined(response.headers.get("x-request-id")) ??
    trimToUndefined(response.headers.get("request-id"))
  );
}

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly statusCode: number;
  readonly code?: string;
  readonly errorCode?: string;
  readonly errorType?: string;
  readonly errorBody?: string;
  readonly requestId?: string;

  constructor(
    message: string,
    params: {
      status: number;
      code?: string;
      type?: string;
      body?: string;
      requestId?: string;
    },
  ) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = params.status;
    this.statusCode = params.status;
    this.code = params.code;
    this.errorCode = params.code;
    this.errorType = params.type;
    this.errorBody = params.body;
    this.requestId = params.requestId;
  }
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
  const info = await extractProviderErrorInfo(response);
  return new ProviderHttpError(
    formatProviderHttpErrorMessage({
      label,
      status: response.status,
      detail: info.detail,
      requestId: info.requestId,
      statusPrefix: options?.statusPrefix,
    }),
    {
      status: response.status,
      code: info.code,
      type: info.type,
      body: info.body,
      requestId: info.requestId,
    },
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
