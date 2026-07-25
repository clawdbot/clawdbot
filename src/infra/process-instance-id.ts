import { randomUUID } from "node:crypto";

const PROCESS_INSTANCE_ID = randomUUID();

export function getOpenClawProcessInstanceId(): string {
  return PROCESS_INSTANCE_ID;
}
