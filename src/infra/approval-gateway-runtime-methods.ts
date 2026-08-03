export const GATEWAY_NATIVE_APPROVAL_METHODS = [
  "approval.resolve",
  "exec.approval.get",
  "exec.approval.list",
  "exec.approval.resolve",
  "plugin.approval.list",
  "plugin.approval.resolve",
] as const;

export type GatewayNativeApprovalMethod = (typeof GATEWAY_NATIVE_APPROVAL_METHODS)[number];

const gatewayNativeApprovalMethods = new Set<string>(GATEWAY_NATIVE_APPROVAL_METHODS);

export function isGatewayNativeApprovalMethod(
  method: string,
): method is GatewayNativeApprovalMethod {
  return gatewayNativeApprovalMethods.has(method);
}
