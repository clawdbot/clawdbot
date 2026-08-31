import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

export const RETURN_COVENANT_GATEWAY_READY_PREFIX = "RETURN_COVENANT_GATEWAY_READY ";

const gatewayBindingSchema = z
  .object({
    bootId: z.string().min(1).max(96),
    endpoint: z.string().regex(/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/u),
    pid: z.number().int().min(2),
    startFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

export type ReturnCovenantGatewayBinding = z.infer<typeof gatewayBindingSchema>;

export type ReturnCovenantGatewayRestart = {
  original: ReturnCovenantGatewayBinding;
  replacement: ReturnCovenantGatewayBinding;
};

export function parseReturnCovenantGatewayBinding(value: unknown): ReturnCovenantGatewayBinding {
  return gatewayBindingSchema.parse(value);
}

export async function readReturnCovenantProcessStartFingerprint(pid: number): Promise<string> {
  const raw = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = raw
    .slice(raw.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u);
  const startTicks = fields[19];
  if (!startTicks) {
    throw new Error(`gateway ${pid} has no kernel start timestamp`);
  }
  return createHash("sha256").update(`${pid}:${startTicks}`).digest("hex");
}

export function returnCovenantGatewayBindingsEqual(
  left: ReturnCovenantGatewayBinding,
  right: ReturnCovenantGatewayBinding,
): boolean {
  return (
    left.bootId === right.bootId &&
    left.endpoint === right.endpoint &&
    left.pid === right.pid &&
    left.startFingerprint === right.startFingerprint
  );
}

export function assertReturnCovenantGatewayBinding(
  actual: ReturnCovenantGatewayBinding,
  expected: ReturnCovenantGatewayBinding,
  message: string,
): void {
  if (!returnCovenantGatewayBindingsEqual(actual, expected)) {
    throw new Error(message);
  }
}
