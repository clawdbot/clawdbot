import {
  createExtensionRelayAuthClient,
  EXTENSION_RELAY_V2_PROTOCOL,
  parseRelayAuthJson,
} from "./relay-auth-v2.js";
import { buildRelayWsProtocols } from "./relay-core.js";

/** Open one v2-only relay socket and expose application frames only after auth.ok. */
export function openAuthenticatedRelaySocket({
  relayUrl,
  token,
  isCurrent,
  onAuthenticated,
  onApplicationMessage,
  onAuthenticationFailure,
  onClose,
}) {
  const authClientPromise = createExtensionRelayAuthClient({ token, relayUrl });
  const ws = new WebSocket(relayUrl, buildRelayWsProtocols());
  let authenticated = false;

  ws.addEventListener("open", () => {
    void (async () => {
      try {
        if (!isCurrent(ws)) {
          ws.close();
          return;
        }
        if (ws.protocol !== EXTENSION_RELAY_V2_PROTOCOL) {
          throw new Error("relay did not negotiate Browser Relay Authentication v2");
        }
        const authClient = await authClientPromise;
        ws.send(JSON.stringify(authClient.start()));
      } catch (error) {
        onAuthenticationFailure(ws, error);
      }
    })();
  });

  let messageChain = Promise.resolve();
  ws.addEventListener("message", (event) => {
    messageChain = messageChain.then(async () => {
      try {
        if (!isCurrent(ws)) {
          return;
        }
        const raw = String(event.data);
        if (authenticated) {
          let message;
          try {
            message = JSON.parse(raw);
          } catch {
            return;
          }
          if (typeof message?.type === "string" && message.type.startsWith("auth.")) {
            throw new Error("relay sent an authentication frame after completion");
          }
          onApplicationMessage(ws, message);
          return;
        }

        const message = parseRelayAuthJson(raw);
        if (!message) {
          throw new Error("relay sent malformed authentication JSON");
        }
        const authClient = await authClientPromise;
        if (message.type === "auth.challenge") {
          const response = await authClient.acceptChallenge(message);
          if (isCurrent(ws) && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(response));
          }
          return;
        }
        if (message.type !== "auth.ok") {
          throw new Error("relay authentication frame is out of sequence");
        }
        await authClient.acceptOk(message);
        if (!isCurrent(ws) || ws.readyState !== WebSocket.OPEN) {
          return;
        }
        authenticated = true;
        await onAuthenticated(ws);
      } catch (error) {
        onAuthenticationFailure(ws, error);
      }
    });
  });

  ws.addEventListener("close", () => onClose(ws, authenticated));
  return ws;
}
