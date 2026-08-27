import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { asPositiveSafeInteger, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import {
  type CrabboxMachineShape,
  listCrabboxMachineOptions,
  nonEmptyString,
  parseCrabboxProfile,
} from "./crabbox-worker-profile.js";
import { CRABBOX_MACHINE_CATALOG_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

type CrabboxMachineShapes = ReadonlyMap<string, readonly CrabboxMachineShape[]>;

type CrabboxMachineOptionsResolverDependencies = {
  resolveBinary: (explicit?: string) => string;
  runCommand: CrabboxCommandRunner;
  warn: (message: string) => void;
};

function parseCrabboxMachineShapes(stdout: string): CrabboxMachineShapes {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("Crabbox providers returned invalid JSON");
  }
  return new Map(
    parsed.flatMap<[string, readonly CrabboxMachineShape[]]>((entry) => {
      // An explicit unmapped disposition overrides even a stray legacy summary.
      if (
        !isRecord(entry) ||
        (isRecord(entry.classCatalog) && entry.classCatalog.disposition === "unmapped")
      ) {
        return [];
      }
      const rawClasses = Array.isArray(entry.classes) ? entry.classes : [];
      const classes = rawClasses.flatMap<CrabboxMachineShape>((raw) => {
        if (!isRecord(raw)) {
          return [];
        }
        const machineClass = nonEmptyString(raw.class);
        if (!machineClass) {
          return [];
        }
        const cpu = asPositiveSafeInteger(raw.vcpu);
        const memoryGb = asPositiveSafeInteger(raw.memoryGb);
        return [
          { class: machineClass, ...(cpu ? { cpu } : {}), ...(memoryGb ? { memoryGb } : {}) },
        ];
      });
      const provider = nonEmptyString(entry.provider)?.toLowerCase();
      return provider && classes.length > 0 ? [[provider, classes]] : [];
    }),
  );
}

export function createCrabboxMachineOptionsResolver(
  dependencies: CrabboxMachineOptionsResolverDependencies,
): NonNullable<WorkerProvider["listMachineOptions"]> {
  const machineShapesByBinary = new Map<string, Promise<CrabboxMachineShapes>>();
  const loadMachineShapes = async (binary: string): Promise<CrabboxMachineShapes> => {
    try {
      // The full provider matrix exceeds the lifecycle command's 64 KiB log cap.
      // Keep catalog JSON intact or every provider loses its machine shapes.
      const result = await dependencies.runCommand([binary, "providers", "--json"], {
        maxOutputBytes: 1024 * 1024,
        killProcessTree: true,
        timeoutMs: CRABBOX_MACHINE_CATALOG_TIMEOUT_MS,
      });
      if (result.termination !== "exit" || result.code !== 0) {
        throw new Error("Crabbox providers command failed");
      }
      return parseCrabboxMachineShapes(result.stdout);
    } catch (error) {
      dependencies.warn(
        `Crabbox machine shapes unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return new Map();
    }
  };

  return async (profile) => {
    const parsed = parseCrabboxProfile(profile);
    const binary = dependencies.resolveBinary(parsed.binary);
    // Provider metadata is process-stable, so one catalog read per resolved binary serves the
    // lifecycle. A shared slot would hand profiles using different Crabbox builds stale sizes.
    let shapes = machineShapesByBinary.get(binary);
    if (!shapes) {
      shapes = loadMachineShapes(binary);
      machineShapesByBinary.set(binary, shapes);
    }
    return listCrabboxMachineOptions(parsed.class, (await shapes).get(parsed.provider));
  };
}
