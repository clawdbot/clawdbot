import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BrowserRouteContext } from "../server-context.js";

let createBrowserRouteDispatcher: typeof import("./dispatcher.js").createBrowserRouteDispatcher;

describe("browser route dispatcher (abort)", () => {
  beforeAll(async () => {
    vi.doMock("./index.js", () => {
      const asyncRoute = <Req, Res>(
        handler: (req: Req, res: Res) => void | Promise<void>,
      ): ((req: Req, res: Res) => void | Promise<void>) => {
        return (req, res) => handler(req, res);
      };
      return {
        registerBrowserRoutes(app: { get: (path: string, handler: unknown) => void }) {
          app.get(
            "/slow",
            asyncRoute(
              async (req: { signal?: AbortSignal }, res: { json: (body: unknown) => void }) => {
                const signal = req.signal;
                await new Promise<void>((resolve, reject) => {
                  if (signal?.aborted) {
                    reject(signal.reason ?? new Error("aborted"));
                    return;
                  }
                  const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
                  signal?.addEventListener("abort", onAbort, { once: true });
                  queueMicrotask(() => {
                    signal?.removeEventListener("abort", onAbort);
                    resolve();
                  });
                });
                res.json({ ok: true });
              },
            ),
          );
          app.get(
            "/echo/:id",
            asyncRoute(
              (
                req: { params?: Record<string, string> },
                res: { json: (body: unknown) => void },
              ) => {
                res.json({ id: req.params?.id ?? null });
              },
            ),
          );
        },
      };
    });
    ({ createBrowserRouteDispatcher } = await import("./dispatcher.js"));
  });

  it("propagates AbortSignal and lets handlers observe abort", async () => {
    const dispatcher = createBrowserRouteDispatcher({} as BrowserRouteContext);

    const ctrl = new AbortController();
    const promise = dispatcher.dispatch({
      method: "GET",
      path: "/slow",
      signal: ctrl.signal,
    });

    ctrl.abort(new Error("timed out"));

    const result = await promise;
    expect(result.status).toBe(500);
    const body = result.body as { error?: unknown };
    expect(body.error).toBe("Error: timed out");
  });

  it("returns 400 for malformed percent-encoding in route params", async () => {
    const dispatcher = createBrowserRouteDispatcher({} as BrowserRouteContext);

    const result = await dispatcher.dispatch({
      method: "GET",
      path: "/echo/%E0%A4%A",
    });
    expect(result.status).toBe(400);
    const body = result.body as { error?: unknown };
    expect(body.error).toBe("invalid path parameter encoding: id");
  });
});
