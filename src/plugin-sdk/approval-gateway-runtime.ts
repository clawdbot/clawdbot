/**
 * Runtime SDK subpath for resolving approval requests over the gateway.
 */
export type { ApprovalResolveResult } from "../../packages/gateway-protocol/src/index.js";
export { resolveApprovalOverGateway } from "../infra/approval-gateway-resolver.js";
