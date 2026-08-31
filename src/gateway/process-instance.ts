import { randomUUID } from "node:crypto";

const gatewayProcessInstanceId = randomUUID();

/** Stable for one Gateway process; changes across every restart, including PID reuse. */
export function getGatewayProcessInstanceId(): string {
  return gatewayProcessInstanceId;
}
