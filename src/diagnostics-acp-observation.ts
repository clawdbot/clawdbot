import { writeSync } from "node:fs";
import { inspect } from "node:util";
import { threadId } from "node:worker_threads";

let sequence = 0;
export function acpObservation(label: string, details: Record<string, unknown> = {}): void {
  writeSync(
    2,
    JSON.stringify({
      marker: "ui-acp-observation",
      label,
      sequence: ++sequence,
      monotonicNs: process.hrtime.bigint().toString(),
      time: new Date().toISOString(),
      pid: process.pid,
      threadId,
      ...details,
    }) + "\n",
  );
}
export function acpObservedError(error: unknown): string {
  return inspect(error, {
    depth: null,
    colors: false,
    showHidden: true,
    maxArrayLength: null,
    maxStringLength: null,
    getters: false,
  });
}
export function acpObservedValue<T>(
  label: string,
  value: T,
  details: Record<string, unknown> = {},
): T {
  acpObservation(label, { ...details, value, present: value !== undefined });
  return value;
}
