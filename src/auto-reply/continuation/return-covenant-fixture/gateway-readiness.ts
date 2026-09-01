import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  parseReturnCovenantGatewayBinding,
  readReturnCovenantProcessStartFingerprint,
  RETURN_COVENANT_GATEWAY_READY_PREFIX,
  type ReturnCovenantGatewayBinding,
} from "./gateway-generation.js";

function gatewayReadyBinding(stdout: string): ReturnCovenantGatewayBinding | undefined {
  const line = stdout
    .split("\n")
    .find((entry) => entry.startsWith(RETURN_COVENANT_GATEWAY_READY_PREFIX));
  if (!line) {
    return undefined;
  }
  return parseReturnCovenantGatewayBinding(
    JSON.parse(line.slice(RETURN_COVENANT_GATEWAY_READY_PREFIX.length)),
  );
}

export async function waitForReturnCovenantGatewayReady(
  gateway: {
    child: Pick<ChildProcess, "exitCode" | "signalCode">;
    label: string;
    pid: number;
    stderr: string;
    stdout: string;
  },
  port: number,
  options: { timeoutMs?: number } = {},
): Promise<ReturnCovenantGatewayBinding> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const expectedStartFingerprint = await readReturnCovenantProcessStartFingerprint(gateway.pid);
  const expectedEndpoint = `http://127.0.0.1:${port}`;
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null || gateway.child.signalCode !== null) {
      const reason =
        gateway.child.signalCode !== null
          ? `signal ${gateway.child.signalCode}`
          : `exit ${gateway.child.exitCode}`;
      throw new Error(
        `gateway ${gateway.label} stopped before readiness (${reason}): ${gateway.stderr.slice(-2000)}`,
      );
    }
    const binding = gatewayReadyBinding(gateway.stdout);
    if (binding) {
      if (
        binding.pid !== gateway.pid ||
        binding.startFingerprint !== expectedStartFingerprint ||
        binding.endpoint !== expectedEndpoint
      ) {
        throw new Error("spawned child published a mismatched gateway readiness binding");
      }
      return binding;
    }
    await delay(25);
  }
  throw new Error(`spawned child ${gateway.label} did not publish gateway readiness`);
}
