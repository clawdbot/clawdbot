// Public node-method registry and wake helpers.
import { nodeEventHandlers } from "./nodes.event.js";
import { nodeInvokeHandlers } from "./nodes.invoke.js";
import { nodePairingHandlers } from "./nodes.pairing.js";
import { nodePendingActionHandlers } from "./nodes.pending.js";
import { nodeReadHandlers } from "./nodes.read.js";
import type { GatewayRequestHandlers } from "./types.js";

export {
  maybeSendNodeWakeNudge,
  maybeWakeNodeWithApns,
  waitForNodeReconnect,
} from "./nodes.wake.js";

export const nodeHandlers: GatewayRequestHandlers = {
  ...nodePairingHandlers,
  ...nodeReadHandlers,
  ...nodePendingActionHandlers,
  ...nodeInvokeHandlers,
  ...nodeEventHandlers,
};
