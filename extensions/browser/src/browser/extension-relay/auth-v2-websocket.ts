import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import type { RawData, WebSocket } from "ws";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { BrowserRelayProofFields } from "./auth-v2-crypto.js";
import {
  BROWSER_RELAY_CHALLENGE_TTL_MS,
  parseRelayAuthHello,
  parseRelayAuthResponse,
  parseStrictJsonObject,
  type BrowserRelayAuthV2Authority,
} from "./auth-v2.js";
import {
  boundedRawDataByteLength,
  MAX_WEBSOCKET_AUTH_MESSAGE_BYTES,
} from "./preauth-websocket-guard.js";
const log = createSubsystemLogger("browser").child("extension-relay");

export function authenticateExtensionWebSocket(params: {
  ws: WebSocket;
  authority: BrowserRelayAuthV2Authority;
  source: string;
  resource: string;
  binding?: Pick<BrowserRelayProofFields, "role" | "flow">;
  prepareAuthenticated: () => Promise<() => void>;
  removePreAuthGuard?: () => void;
}): void {
  const { ws, authority } = params;
  // ws closes on receiver/sender errors, but still emits an application error.
  // Own it before proof and through promotion to borrowed ingress or owner streams.
  ws.on("error", (err) => log.warn(`relay socket error: ${String(err)}`));
  let stage: "hello" | "response" | "authenticated" | "failed" = "hello";
  let preAuthGuardActive = true;
  const removePreAuthGuard = () => {
    if (!preAuthGuardActive) {
      return;
    }
    preAuthGuardActive = false;
    params.removePreAuthGuard?.();
  };
  const closePreAuthSocket = (code: number, reason: string) => {
    ws.close(code, reason);
    const terminateTimer = setTimeout(() => ws.terminate(), 100);
    terminateTimer.unref?.();
  };
  const timer = setTimeout(() => {
    stage = "failed";
    ws.off("message", onMessage);
    ws.close(4008, "browser relay auth timeout");
    ws.terminate();
  }, BROWSER_RELAY_CHALLENGE_TTL_MS);
  timer.unref?.();
  const release = () => {
    clearTimeout(timer);
    removePreAuthGuard();
    authority.releaseConnection(ws);
  };
  if (
    !authority.registerPendingConnection(
      ws,
      () => {
        ws.close(4003, "browser relay key rotated");
      },
      params.source,
    )
  ) {
    clearTimeout(timer);
    closePreAuthSocket(4013, "browser relay auth capacity reached");
    return;
  }
  ws.once("close", release);
  const fail = (code: number, reason: string) => {
    if (stage === "failed") {
      return;
    }
    stage = "failed";
    clearTimeout(timer);
    ws.off("message", onMessage);
    closePreAuthSocket(code, reason);
  };
  const onMessage = (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      fail(4003, "binary browser relay auth frames are not allowed");
      return;
    }
    if (
      boundedRawDataByteLength(data, MAX_WEBSOCKET_AUTH_MESSAGE_BYTES) >
      MAX_WEBSOCKET_AUTH_MESSAGE_BYTES
    ) {
      fail(4003, "browser relay auth frame is too large");
      return;
    }
    const raw = rawDataToString(data);
    const parsed = parseStrictJsonObject(raw);
    if (stage === "hello") {
      const hello = parseRelayAuthHello(parsed);
      if (!hello) {
        fail(4003, "invalid browser relay auth hello");
        return;
      }
      const challenge = authority.issueChallenge(ws, hello, {
        role: params.binding?.role ?? "extension",
        transport: "websocket",
        method: "GET",
        resource: params.resource,
        flow: params.binding?.flow ?? "extension",
      });
      if (!challenge) {
        fail(4003, "browser relay auth rejected");
        return;
      }
      stage = "response";
      ws.send(JSON.stringify(challenge));
      return;
    }
    if (stage === "response") {
      const response = parseRelayAuthResponse(parsed);
      if (!response) {
        fail(4003, "invalid browser relay auth response");
        return;
      }
      const completed = authority.completeChallenge(ws, response);
      if (!completed) {
        fail(4003, "browser relay auth proof failed");
        return;
      }
      stage = "authenticated";
      // The proof deadline owns only challenge completion. Promotion is now
      // authoritative, so cold Browser/Gateway preparation must not race it.
      clearTimeout(timer);
      removePreAuthGuard();
      void params
        .prepareAuthenticated()
        .then((attach) => {
          if (ws.readyState !== 1) {
            return;
          }
          ws.off("message", onMessage);
          attach();
          ws.send(JSON.stringify(completed.ok), (err) => {
            if (err) {
              ws.close(1011, "browser relay auth acknowledgement failed");
            }
          });
        })
        .catch((err: unknown) => {
          log.warn(`browser relay post-auth preparation failed: ${String(err)}`);
          fail(1011, "browser relay unavailable after authentication");
        });
      return;
    }
    fail(4003, "unexpected browser relay auth frame");
  };
  ws.on("message", onMessage);
}
