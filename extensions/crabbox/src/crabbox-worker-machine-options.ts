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
      if (
        !isRecord(entry) ||
        !isRecord(entry.classCatalog) ||
        entry.classCatalog.disposition !== "mapped"
      ) {
        return [];
      }
      const profiles = Array.isArray(entry.classCatalog.profiles)
        ? entry.classCatalog.profiles
        : [];
      const classes = profiles.flatMap<CrabboxMachineShape>((raw) => {
        // Match Crabbox's default Linux/amd64 projection; other selectors and
        // fallback machines do not describe this primary choice.
        if (
          !isRecord(raw) ||
          raw.target !== "linux" ||
          raw.architecture !== "amd64" ||
          !isRecord(raw.primary)
        ) {
          return [];
        }
        const machineClass = nonEmptyString(raw.class);
        if (!machineClass) {
          return [];
        }
        const cpu = asPositiveSafeInteger(raw.primary.vcpu);
        const memory = raw.primary.memory;
        // Crabbox's integer memoryGb summary accepts GB/GiB only, without rounding.
        const memoryGb =
          isRecord(memory) && (memory.unit === "GB" || memory.unit === "GiB")
            ? asPositiveSafeInteger(memory.value)
            : undefined;
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
    // The full provider matrix exceeds the lifecycle command's 64 KiB log cap.
    // Keep catalog JSON intact or every provider loses its machine shapes.
    const result = await dependencies.runCommand([binary, "providers", "--json"], {
      maxOutputBytes: 1024 * 1024,
      killProcessTree: true,
      timeoutMs: CRABBOX_MACHINE_CATALOG_TIMEOUT_MS,
    });
    if (result.termination !== "exit" || result.code !== 0) {
      throw new Error(
        `Crabbox providers command failed (${result.termination}, code ${result.code})`,
      );
    }
    return parseCrabboxMachineShapes(result.stdout);
  };

  return async (profile) => {
    const parsed = parseCrabboxProfile(profile);
    const binary = dependencies.resolveBinary(parsed.binary);
    // Cache successful metadata per binary; different builds may advertise different sizes.
    // One rejection handler per load runs after insertion, including synchronous runner throws.
    let shapes = machineShapesByBinary.get(binary);
    if (!shapes) {
      shapes = loadMachineShapes(binary).catch((error: unknown) => {
        machineShapesByBinary.delete(binary);
        dependencies.warn(
          `Crabbox machine shapes unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        return new Map();
      });
      machineShapesByBinary.set(binary, shapes);
    }
    return listCrabboxMachineOptions(parsed.class, (await shapes).get(parsed.provider));
  };
}
