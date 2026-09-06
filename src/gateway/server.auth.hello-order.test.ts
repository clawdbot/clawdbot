import { once } from "node:events";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { writeConfigFile } from "../config/config.js";
import type { SystemPresence } from "../infra/system-presence.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  openWs,
  onceMessage,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const origin = "https://control.example.com";

type ObservedFrame = {
  type?: string;
  event?: string;
  payload?: {
    type?: string;
    presence?: SystemPresence[];
    snapshot?: { presence?: SystemPresence[] };
  };
};

async function configureAuth() {
  const auth = {
    mode: "trusted-proxy" as const,
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
  };
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [origin] };
  await writeConfigFile({
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1"],
      controlUi: { allowedOrigins: [origin] },
    },
  });
}

async function openBrowser(port: number, instanceId: string) {
  const socket = await openWs(port, {
    origin,
    "x-forwarded-for": "203.0.113.50",
    "x-forwarded-proto": "https",
    "x-forwarded-user": `${instanceId}@example.com`,
  });
  const frames: ObservedFrame[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(rawDataToString(data))));
  return {
    socket,
    frames,
    connect: () =>
      connectReq(socket, {
        skipDefaultAuth: true,
        prePairDevice: true,
        client: { ...CONTROL_UI_CLIENT, instanceId },
        scopes: ["operator.read"],
        browserOrigin: origin,
      }),
  };
}

function presenceReasons(frames: ObservedFrame[], instanceId: string) {
  return frames
    .filter((frame) => frame.event === "presence")
    .flatMap((frame) => frame.payload?.presence ?? [])
    .filter((entry) => entry.instanceId === instanceId)
    .map((entry) => entry.reason);
}

describe("Gateway hello publication", () => {
  test("sends hello before connect presence and promptly notifies established readers", async () => {
    await configureAuth();
    await withGatewayServer(async ({ port }) => {
      const reader = await openBrowser(port, "established-reader");
      const joining = await openBrowser(port, "joining-browser");
      try {
        expect((await reader.connect()).ok).toBe(true);
        const notified = onceMessage<ObservedFrame>(
          reader.socket,
          (frame) =>
            frame.event === "presence" &&
            frame.payload?.presence?.some(
              (entry) => entry.instanceId === "joining-browser" && entry.reason === "connect",
            ) === true,
        );
        const [result] = await Promise.all([joining.connect(), notified]);
        expect(result.ok, JSON.stringify(result.error)).toBe(true);
        const firstFrame = joining.frames.find((frame) => frame.event !== "connect.challenge");
        expect(firstFrame?.payload?.type ?? firstFrame?.event).toBe("hello-ok");
        expect(firstFrame?.payload?.snapshot?.presence?.map((entry) => entry.instanceId)).toContain(
          "joining-browser",
        );
        expect(presenceReasons(reader.frames, "joining-browser")).toContain("connect");
      } finally {
        joining.socket.close();
        reader.socket.close();
      }
    });
  });

  test.each(["write-error", "closed-before-callback"] as const)(
    "does not publish connect presence after hello %s and retains disconnect cleanup",
    async (failure) => {
      await configureAuth();
      const failedInstanceId = `failed-${failure}`;
      await withGatewayServer(async ({ port }) => {
        const reader = await openBrowser(port, "established-reader");
        const joining = await openBrowser(port, failedInstanceId);
        let failNextHello = true;
        try {
          expect((await reader.connect()).ok).toBe(true);
          const originalSend = Reflect.get(WebSocket.prototype, "send");
          const sendSpy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
            this: WebSocket,
            ...args: Parameters<WebSocket["send"]>
          ) {
            if (failNextHello && typeof args[0] === "string" && args[0].includes('"hello-ok"')) {
              failNextHello = false;
              const callback = args.findLast((arg) => typeof arg === "function");
              if (failure === "closed-before-callback") {
                this.close(1000, "test close before hello");
              }
              if (typeof callback === "function") {
                callback(
                  failure === "write-error" ? new Error("test hello write failure") : undefined,
                );
              }
              return;
            }
            Reflect.apply(originalSend, this, args);
          });
          try {
            const closed = once(joining.socket, "close");
            const disconnected = onceMessage<ObservedFrame>(
              reader.socket,
              (frame) =>
                frame.event === "presence" &&
                frame.payload?.presence?.some(
                  (entry) => entry.instanceId === failedInstanceId && entry.reason === "disconnect",
                ) === true,
            );
            await Promise.all([
              expect(joining.connect()).rejects.toThrow(/closed/),
              closed,
              disconnected,
            ]);
            expect(failNextHello).toBe(false);
            const reasons = presenceReasons(reader.frames, failedInstanceId);
            expect(reasons).not.toContain("connect");
            expect(reasons).toContain("disconnect");
          } finally {
            sendSpy.mockRestore();
          }
        } finally {
          joining.socket.close();
          reader.socket.close();
        }
      });
    },
  );
});
