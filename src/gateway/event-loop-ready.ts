// Re-export the gateway-client readiness primitive through the server gateway
// package so callers use one event-loop readiness contract.
export {
  waitForEventLoopReady,
  type EventLoopReadyResult,
} from "../../packages/gateway-client/src/event-loop-ready.js";
