import { runInNewContext } from "node:vm";
import { expect, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

export type StandaloneHostBrowserOptions = {
  operationStatus?: number;
  initialBody?: ReturnType<typeof createDeferred<unknown>>;
  abortable401Body?: boolean;
};

export async function createStandaloneHostBrowserHarness(
  options: StandaloneHostBrowserOptions & { source: string; ticket: string; payload: unknown },
) {
  const { source, ticket, payload } = options;
  const listeners = new Map<string, (event: unknown) => void>();
  const timers: Array<{ run: () => void; delayMs: number }> = [];
  const postMessage = vi.fn();
  const frame = { contentWindow: { postMessage }, setAttribute: vi.fn(), remove: vi.fn() };
  const replaceChildren = vi.fn();
  const timeout = vi.fn(() => new AbortController().signal);
  const reload = vi.fn();
  const operations: Array<{
    signal: AbortSignal | undefined;
    result: ReturnType<typeof createDeferred<unknown>>;
    response?: Response;
  }> = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method !== "POST") {
      return {
        ok: true,
        json: async () => (options.initialBody ? await options.initialBody.promise : payload),
      };
    }
    const result = createDeferred<unknown>();
    const signal = init.signal ?? undefined;
    const operation: (typeof operations)[number] = { signal, result };
    operations.push(operation);
    if (options.abortable401Body) {
      operation.response = new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(signal.reason), {
              once: true,
            });
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return operation.response;
    }
    return {
      ok: (options.operationStatus ?? 200) === 200,
      status: options.operationStatus ?? 200,
      json: async () => ({ ok: true, result: await result.promise }),
    };
  });
  runInNewContext(source, {
    AbortController,
    AbortSignal: { timeout },
    URL,
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    document: { createElement: () => frame, getElementById: () => ({ replaceChildren }) },
    fetch,
    innerWidth: 800,
    location: { hash: `#${ticket}`, origin: "http://127.0.0.1:18789", reload },
    matchMedia: () => ({ matches: false }),
    navigator: { language: "en" },
    setTimeout: (run: () => void, delayMs: number) => timers.push({ run, delayMs }),
  });
  const emit = (data: unknown, overrides: { source?: unknown; origin?: string } = {}) =>
    listeners.get("message")?.({
      data,
      origin: "http://127.0.0.1:18790",
      source: frame.contentWindow,
      ...overrides,
    });
  const initialize = {
    jsonrpc: "2.0",
    id: "initialize",
    method: "ui/initialize",
    params: {
      protocolVersion: "2026-01-26",
      appInfo: { name: "demo", version: "1" },
      appCapabilities: {},
    },
  };
  if (!options.initialBody) {
    await vi.waitFor(() => expect(replaceChildren).toHaveBeenCalledWith(frame));
    emit(initialize);
    emit({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    postMessage.mockClear();
  }
  return {
    emit,
    initialize,
    operations,
    postMessage,
    frame,
    payload,
    replaceChildren,
    timers,
    timeout,
    reload,
    pagehide: (persisted = false) => listeners.get("pagehide")?.({ persisted }),
    pageshow: (persisted = false) => listeners.get("pageshow")?.({ persisted }),
  };
}
