import { Script } from "node:vm";
import { JSDOM } from "jsdom";
import { it } from "vitest";

type ResponseFrame = {
  type: "res";
  id: string;
  event?: never;
  ok: boolean;
  payload?: unknown;
  error?: { message: string };
};

type GatewayFrame = ResponseFrame | { type: "event"; event: string; id?: never; payload?: unknown };

type RecordedSocket = {
  frames: GatewayFrame[];
  send: (id: string, method: string, params?: unknown) => void;
  request: (id: string, method: string, params: unknown) => Promise<Record<string, unknown>>;
};

type MockGatewayPage = {
  window: Window & typeof globalThis;
  execute: (script: string) => void;
  connect: (url?: string) => RecordedSocket;
  responses: ResponseFrame[];
  close: () => void;
};

export function flushMockTimers(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export const mockGatewayTest = it.extend<{ gatewayPage: MockGatewayPage }>({
  gatewayPage: async ({ task }, use) => {
    const dom = new JSDOM("", { url: "http://mock-control-ui/", runScripts: "outside-only" });
    const responses: ResponseFrame[] = [];
    try {
      await use({
        window: dom.window as unknown as Window & typeof globalThis,
        execute: (script) => {
          new Script(script, { filename: `mock-gateway:${task.name}` }).runInContext(
            dom.getInternalVMContext(),
          );
        },
        connect: (url = "ws://mock-gateway") => {
          const socket = new dom.window.WebSocket(url);
          const frames: GatewayFrame[] = [];
          socket.addEventListener("message", (event) => {
            const frame = JSON.parse(String(event.data)) as GatewayFrame;
            frames.push(frame);
            if (frame.type === "res") {
              // Record arrivals across sockets here; concatenating socket logs loses ordering.
              responses.push(frame);
            }
          });
          const send = (id: string, method: string, params?: unknown) =>
            socket.send(JSON.stringify({ type: "req", id, method, params }));
          return {
            frames,
            send,
            request: async (id, method, params) => {
              send(id, method, params);
              await flushMockTimers();
              const response = frames.find((frame) => frame.type === "res" && frame.id === id);
              if (!response) {
                throw new Error(`No mock response for ${method}`);
              }
              return response.payload as Record<string, unknown>;
            },
          };
        },
        responses,
        close: () => dom.window.close(),
      });
    } finally {
      // The serialized script owns page globals, listeners and queued work.
      // Close its realm even on assertion failure; never install it in Vitest's shared window.
      dom.window.close();
    }
  },
});
