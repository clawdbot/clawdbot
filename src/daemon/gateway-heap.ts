/** Adaptive Node heap policy for the managed Gateway service. */
import os from "node:os";
import type { GatewayDaemonRuntime } from "../commands/daemon-runtime.js";
import { parseNodeOptionsEnvVar } from "../infra/node-options.js";
import { resolveServiceEntrypointIndex } from "./service-layout.js";
import {
  hasGatewayServiceEnvironmentOverride,
  resolveManagedGatewayServiceCommand,
  type GatewayServiceCommandConfig,
} from "./service-types.js";

const MEBIBYTE_BYTES = 1024 * 1024;
const GATEWAY_HEAP_FLOOR_MIB = 2048;
const GATEWAY_HEAP_CAP_MIB = 8192;

type GatewayHeapMemorySource = "constrained" | "physical" | "unknown";

type GatewayHeapLimit = {
  maxOldSpaceSizeMiB: number | null;
  availableMemoryMiB: number | null;
  memorySource: GatewayHeapMemorySource;
  floorMiB: number;
  capMiB: number;
  headroomCapMiB: number | null;
};

export type GatewayHeapLimitReport = GatewayHeapLimit & {
  nodeOptions: string;
  execArgv: string[];
};

type GatewayHeapMemoryInputs = {
  constrainedMemoryBytes?: number;
  physicalMemoryBytes?: number;
};

function readAvailableMemory(params: GatewayHeapMemoryInputs): {
  bytes: number | null;
  source: GatewayHeapMemorySource;
} {
  const constrainedMemoryBytes = params.constrainedMemoryBytes ?? process.constrainedMemory();
  const physicalMemoryBytes = params.physicalMemoryBytes ?? os.totalmem();
  const validPhysical = Number.isSafeInteger(physicalMemoryBytes) && physicalMemoryBytes > 0;
  if (
    Number.isSafeInteger(constrainedMemoryBytes) &&
    constrainedMemoryBytes > 0 &&
    (!validPhysical || constrainedMemoryBytes <= physicalMemoryBytes)
  ) {
    return { bytes: constrainedMemoryBytes, source: "constrained" };
  }
  return {
    bytes: validPhysical ? physicalMemoryBytes : null,
    source: validPhysical ? "physical" : "unknown",
  };
}

function resolveGatewayHeapLimit(params: GatewayHeapMemoryInputs = {}): GatewayHeapLimit {
  const memory = readAvailableMemory(params);
  if (memory.bytes === null || memory.bytes < 2 * MEBIBYTE_BYTES) {
    return {
      maxOldSpaceSizeMiB: null,
      availableMemoryMiB: null,
      memorySource: "unknown",
      floorMiB: GATEWAY_HEAP_FLOOR_MIB,
      capMiB: GATEWAY_HEAP_CAP_MIB,
      headroomCapMiB: null,
    };
  }
  const availableMemoryMiB = Math.floor(memory.bytes / MEBIBYTE_BYTES);
  const halfMemoryMiB = Math.floor(availableMemoryMiB / 2);
  const capMiB = Math.max(GATEWAY_HEAP_CAP_MIB, Math.floor(availableMemoryMiB / 4));
  // Old space is only part of Gateway RSS. Bound the nominal floor so smaller
  // hosts retain room for young-generation, native, and buffer allocations.
  const headroomCapMiB = Math.floor(availableMemoryMiB * 0.75);
  return {
    maxOldSpaceSizeMiB: Math.min(
      capMiB,
      Math.max(GATEWAY_HEAP_FLOOR_MIB, halfMemoryMiB),
      headroomCapMiB,
    ),
    availableMemoryMiB,
    memorySource: memory.source,
    floorMiB: GATEWAY_HEAP_FLOOR_MIB,
    capMiB,
    headroomCapMiB,
  };
}

function parseHeapControls(tokens: readonly string[]): string[] {
  const controls = new Map<string, number>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--") {
      break;
    }
    const match =
      /^(--max(?:[-_]old[-_]space[-_]size(?:[-_]percentage)?|[-_]heap[-_]size))(?:=(.*))?$/u.exec(
        token,
      );
    if (!match) {
      continue;
    }
    const flag = (match[1] ?? "").replaceAll("_", "-");
    const rawValue = match[2] ?? tokens[++index] ?? "";
    const value = Number(rawValue);
    const valid = flag.endsWith("-percentage")
      ? Number.isFinite(value) && value > 0 && value <= 100
      : /^\+?\d+$/u.test(rawValue) && Number.isSafeInteger(value) && value >= 0;
    if (valid) {
      controls.set(flag, value);
    }
  }
  // Keep total-heap and old-space controls together: V8 uses both to size its
  // generations. Node resolves percentage precedence and argv overrides itself.
  return Array.from(controls, ([flag, value]) => `${flag}=${value}`);
}

export function resolveGatewayHeapNodeOptions(
  existingNodeOptions: string | undefined,
  runtime: GatewayDaemonRuntime = "node",
): string {
  // Keep the durable service value heap-only. Ambient or adjacent startup flags
  // must not reopen the NODE_OPTIONS preload/debug boundary.
  const controls = parseHeapControls(parseNodeOptionsEnvVar(existingNodeOptions) ?? []).join(" ");
  if (controls || runtime !== "bun") {
    return controls;
  }
  // Bun retains its existing environment budget; only direct Node services move
  // automatic sizing to argv. Do not change Bun's spawned-Node behavior here.
  const limit = resolveGatewayHeapLimit().maxOldSpaceSizeMiB;
  return limit === null ? "" : `--max-old-space-size=${Math.min(GATEWAY_HEAP_CAP_MIB, limit)}`;
}

function readServiceHeapExecArgv(programArguments: readonly string[]): string[] {
  const entrypointIndex = resolveServiceEntrypointIndex(programArguments);
  return parseHeapControls(programArguments.slice(1, entrypointIndex ?? 1));
}

export function resolveGatewayHeapExecArgv(
  existingCommand?: GatewayServiceCommandConfig | null,
): string[] {
  const managed = resolveManagedGatewayServiceCommand(existingCommand);
  const existing = readServiceHeapExecArgv(managed?.programArguments ?? []);
  // Stored argv already has native precedence. A new automatic flag must not
  // shadow operator-owned NODE_OPTIONS, even an empty value or an environment reset.
  if (
    existing.length ||
    resolveGatewayHeapNodeOptions(managed?.environment?.NODE_OPTIONS) ||
    hasGatewayServiceEnvironmentOverride(existingCommand, ["NODE_OPTIONS"])
  ) {
    return existing;
  }
  const limit = resolveGatewayHeapLimit().maxOldSpaceSizeMiB;
  return limit === null ? [] : [`--max-old-space-size=${limit}`];
}

export function inspectGatewayHeapLimit(
  nodeOptions: string | undefined,
  memory: GatewayHeapMemoryInputs = {},
  programArguments: readonly string[] = [],
): GatewayHeapLimitReport {
  return {
    ...resolveGatewayHeapLimit(memory),
    nodeOptions: resolveGatewayHeapNodeOptions(nodeOptions),
    execArgv: readServiceHeapExecArgv(programArguments),
  };
}

export function formatGatewayHeapLimitReport(report: GatewayHeapLimitReport): string {
  const configured =
    [
      report.nodeOptions ? `service NODE_OPTIONS: ${report.nodeOptions}` : "",
      report.execArgv.length ? `service argv: ${report.execArgv.join(" ")}` : "",
    ]
      .filter(Boolean)
      .join("; ") || "no service heap control";
  const recommendation =
    report.maxOldSpaceSizeMiB === null
      ? "unavailable (unknown capacity; use Node default)"
      : `${report.maxOldSpaceSizeMiB} MiB old space (${report.availableMemoryMiB} MiB ${report.memorySource} capacity; adaptive cap ${report.capMiB} MiB; native headroom cap ${report.headroomCapMiB} MiB)`;
  return `${configured}; installer recommendation: ${recommendation}; runtime V8 ceiling: not measured`;
}
