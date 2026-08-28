import type { ConfigSnapshotReadMeasure } from "../config/io.js";
import { isTruthyEnvValue } from "../infra/env.js";

const startupPreflightTraceStartedAt = performance.now();

async function measureGatewayStartupPreflightStep<T>(
  name: string,
  run: () => T | Promise<T>,
): Promise<T> {
  if (!isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE)) {
    return await run();
  }
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    const durationMs = performance.now() - startedAt;
    const totalMs = performance.now() - startupPreflightTraceStartedAt;
    const { formatConsoleDiagnosticLine } = await import("../logging/json-console-line.js");
    const message = `[gateway] startup trace: cli.bootstrap.${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms`;
    process.stderr.write(`${formatConsoleDiagnosticLine({ level: "info", message })}\n`);
  }
}

export async function measureDoctorConfigPreflightStep<T>(
  name: string,
  run: () => T | Promise<T>,
  measure?: ConfigSnapshotReadMeasure,
): Promise<T> {
  const tracedRun = () => measureGatewayStartupPreflightStep(name, run);
  return measure ? await measure(`doctor.config-preflight.${name}`, tracedRun) : await tracedRun();
}
