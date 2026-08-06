// Runtime fetch adapter preserves undici dispatcher support and normalizes
// headers/FormData before calling the runtime fetch implementation.
import type { Dispatcher } from "undici";
import { normalizeHeadersInitForFetch } from "../fetch-headers.js";
import { isFormDataLike } from "./form-data.js";
import { loadUndiciRuntimeDeps, type UndiciRuntimeDeps } from "./undici-runtime.js";

export type DispatcherAwareRequestInit = RequestInit & { dispatcher?: Dispatcher };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type RuntimeFormDataCtor = NonNullable<UndiciRuntimeDeps["FormData"]>;

type FormDataEntryValueWithOptionalName = FormDataEntryValue & { name?: string };

function normalizeRuntimeFormData(
  body: unknown,
  RuntimeFormData: RuntimeFormDataCtor | undefined,
): BodyInit | null | undefined {
  // Node global FormData and undici runtime FormData can differ; rebuild into
  // the runtime constructor so multipart uploads stream correctly.
  if (!isFormDataLike(body) || typeof RuntimeFormData !== "function") {
    return body as BodyInit | null | undefined;
  }
  if (body instanceof RuntimeFormData) {
    return body;
  }

  // Node's global FormData and undici's runtime FormData can be different
  // constructors. Rebuild entries so runtime fetch can stream multipart bodies.
  const next = new RuntimeFormData();
  for (const [key, value] of body.entries()) {
    const namedValue = value as FormDataEntryValueWithOptionalName;
    // File.name is the standard filename property; skip empty/whitespace-only values
    const fileName =
      typeof namedValue.name === "string" && namedValue.name.trim() ? namedValue.name : undefined;
    if (fileName) {
      next.append(key, value, fileName);
    } else {
      next.append(key, value);
    }
  }
  // undici.FormData is structurally compatible with BodyInit but lives in a separate
  // type namespace; the cast avoids a cross-implementation assignability error.
  return next as unknown as BodyInit;
}

function normalizeRuntimeRequestInit(
  init: DispatcherAwareRequestInit | undefined,
  RuntimeFormData: RuntimeFormDataCtor | undefined,
): DispatcherAwareRequestInit | undefined {
  if (!init) {
    return init;
  }
  const normalizedHeaders = normalizeHeadersInitForFetch(init.headers);
  const initWithNormalizedHeaders =
    normalizedHeaders === init.headers ? init : { ...init, headers: normalizedHeaders };
  if (!init.body) {
    return initWithNormalizedHeaders;
  }

  const body = normalizeRuntimeFormData(init.body, RuntimeFormData);
  if (body === init.body) {
    return initWithNormalizedHeaders;
  }

  // The rebuilt FormData will choose its own boundary and length; stale caller
  // values make undici send an invalid multipart request.
  const headers = new Headers(normalizedHeaders);
  headers.delete("content-length");
  headers.delete("content-type");
  return {
    ...initWithNormalizedHeaders,
    headers,
    body,
  };
}

/** Returns true for Vitest-style mocked fetch functions that should stay injectable. */
export function isMockedFetch(fetchImpl: FetchLike | undefined): boolean {
  if (typeof fetchImpl !== "function") {
    return false;
  }
  return typeof (fetchImpl as FetchLike & { mock?: unknown }).mock === "object";
}

/** Uses the undici runtime fetch so callers can pass dispatcher-aware options. */
export async function fetchWithRuntimeDispatcher(
  input: RequestInfo | URL,
  init?: DispatcherAwareRequestInit,
): Promise<Response> {
  return await fetchWithPreparedRuntimeDispatcher(loadUndiciRuntimeDeps(), input, init);
}

/** Uses one prepared Undici snapshot so reusable fetch wrappers stay stable. */
export function fetchWithPreparedRuntimeDispatcher(
  runtimeDeps: UndiciRuntimeDeps,
  input: RequestInfo | URL,
  init?: DispatcherAwareRequestInit,
): Promise<Response> {
  const runtimeFetch = runtimeDeps.fetch as unknown as (
    input: RequestInfo | URL,
    init?: DispatcherAwareRequestInit,
  ) => Promise<Response>;
  return runtimeFetch(input, normalizeRuntimeRequestInit(init, runtimeDeps.FormData));
}

/**
 * Uses test-injected global fetch when present, otherwise preserves dispatcher
 * support by routing through the undici runtime fetch.
 */
export async function fetchWithRuntimeDispatcherOrMockedGlobal(
  input: RequestInfo | URL,
  init?: DispatcherAwareRequestInit,
): Promise<Response> {
  if (isMockedFetch(globalThis.fetch)) {
    return await globalThis.fetch(input, init);
  }
  return await fetchWithRuntimeDispatcher(input, init);
}
