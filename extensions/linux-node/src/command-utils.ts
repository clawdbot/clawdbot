import type { OpenClawPluginNodeHostCommandAvailabilityContext } from "openclaw/plugin-sdk/plugin-entry";
import type { CommandOptions, SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  resolveLinuxNodePluginConfigFromHost,
  type ResolvedLinuxNodePluginConfig,
} from "./config.js";

export type RunCommand = (argv: string[], options: CommandOptions) => Promise<SpawnResult>;

export function parseParams(paramsJSON: string | null | undefined): Record<string, unknown> {
  if (!paramsJSON) {
    return {};
  }
  try {
    const parsed = JSON.parse(paramsJSON) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function formatToolError(result: SpawnResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail
    ? truncateUtf16Safe(detail.replaceAll(/\s+/gu, " "), 300)
    : `exit ${result.code ?? "unknown"}`;
}

export function assertToolResult(result: SpawnResult, code: string): void {
  if (result.termination === "timeout" || result.termination === "no-output-timeout") {
    throw new Error(`${code}: command timed out`);
  }
  if (result.code !== 0) {
    throw new Error(`${code}: ${formatToolError(result)}`);
  }
}

export function isCapabilityEnabledForHost(
  context: OpenClawPluginNodeHostCommandAvailabilityContext,
  capability: keyof ResolvedLinuxNodePluginConfig,
): boolean {
  return resolveLinuxNodePluginConfigFromHost(context.config)?.[capability].enabled === true;
}
