import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardWidget } from "./types.ts";
import { BoardWidgetSandboxHost } from "./widget-sandbox-host.ts";

const SANDBOX_URL = "https://sandbox.example/mcp-app-sandbox";

function widget(viewGeneration = "a".repeat(32)): BoardWidget {
  return {
    name: "weather",
    tabId: "main",
    contentKind: "html",
    sizeW: 6,
    sizeH: 4,
    position: 0,
    grantState: "granted",
    revision: 2,
    viewTicket: "ticket",
    viewGeneration,
  };
}

function createHost(waitForRender = false) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const onLoadFailed = vi.fn();
  const onLoaded = vi.fn();
  const options = {
    frame,
    widget: widget(),
    sandboxOrigin: "https://sandbox.example",
    sandboxUrl: SANDBOX_URL,
    sourceOrigin: "https://gateway.example",
    resolveFrameUrl: () => "/widget?generation=first",
    confirmPrompt: () => true,
    onFrameUrl: vi.fn(),
    onLoadFailed,
    onUnauthorized: vi.fn(),
    onReadyTimeout: vi.fn(),
    onLoaded,
    onRendered: waitForRender ? vi.fn() : undefined,
    onError: vi.fn(),
  };
  const host = new BoardWidgetSandboxHost(options);
  host.handleMessage(
    new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "https://sandbox.example",
      data: {
        method: "ui/notifications/sandbox-proxy-ready",
        params: { sandboxUrl: SANDBOX_URL },
      },
    }),
  );
  return { host, onLoadFailed, onLoaded, options };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("BoardWidgetSandboxHost document timeout", () => {
  it.each(["headers", "body", "render"] as const)(
    "times out stalled %s delivery",
    async (phase) => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "fetch",
        vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
          if (phase === "render") {
            return Promise.resolve(new Response("<!doctype html><p>Waiting for a resource</p>"));
          }
          const signal = init?.signal;
          if (phase === "headers") {
            return new Promise<Response>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(new Error("request aborted")));
            });
          }
          return Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("<!doctype html>"));
                  signal?.addEventListener("abort", () =>
                    controller.error(new Error("body aborted")),
                  );
                },
              }),
            ),
          );
        }),
      );
      const { host, onLoadFailed, onLoaded, options } = createHost(phase === "render");

      await vi.advanceTimersByTimeAsync(10_000);

      if (phase === "render") {
        expect(onLoadFailed).not.toHaveBeenCalled();
        expect(options.onError).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining("did not finish loading") }),
        );
      } else {
        expect(onLoadFailed).toHaveBeenCalledWith(widget());
        expect(onLoadFailed).toHaveBeenCalledOnce();
      }
      expect(onLoaded).toHaveBeenCalledTimes(phase === "render" ? 1 : 0);
      host.dispose();
    },
  );

  it.each(["generation", "client"] as const)(
    "keeps a replacement document after a %s change cancels a stalled load",
    async (change) => {
      vi.useFakeTimers();
      let firstSignal: AbortSignal | undefined;
      const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (fetchMock.mock.calls.length === 1) {
          firstSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            firstSignal?.addEventListener("abort", () => reject(new Error("request aborted")));
          });
        }
        return Promise.resolve(new Response("<!doctype html><p>replacement</p>"));
      });
      vi.stubGlobal("fetch", fetchMock);
      const { host, onLoadFailed, onLoaded, options } = createHost();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

      host.update({
        ...options,
        ...(change === "generation"
          ? { widget: widget("b".repeat(32)) }
          : { client: { request: vi.fn(async () => ({ ok: true })) } }),
        resolveFrameUrl: () => "/widget?generation=replacement",
      });
      await vi.waitFor(() => expect(onLoaded).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(10_000);

      expect(firstSignal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(onLoadFailed).not.toHaveBeenCalled();
      expect(onLoaded).toHaveBeenCalledOnce();
      host.dispose();
    },
  );
});
