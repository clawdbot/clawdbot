// Outbound message identity recording for echo suppression.
//
// Split from the `channel-outbound` barrel, which also value-loads the
// reply-pipeline/channel-registry graph that doctor enumeration must not
// cold-load from a legacy-setup closure.

export { recordOutboundMessageIdentity } from "../channels/message/outbound-echo.js";
