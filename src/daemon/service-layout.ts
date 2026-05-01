import fs from "node:fs/promises";
import path from "node:path";
import { readPackageName, readPackageVersion } from "../infra/package-json.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";

export type GatewayServiceLayoutSummary = {
  execStart: string;
  sourcePath?: string;
  sourcePathReal?: string;
  sourceScope?: "user" | "system";
  entrypoint?: string;
  entrypointReal?: string;
  packageRoot?: string;
  packageRootReal?: string;
  packageVersion?: string;
  entrypointSourceCheckout?: boolean;
};

function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatExecStart(programArguments: readonly string[]): string {
  return programArguments.map(shellQuoteArg).join(" ");
}

function resolveSystemdScopeFromServicePath(
  sourcePath: string | undefined,
): "user" | "system" | undefined {
  const normalized = sourcePath?.replaceAll("\\", "/") ?? "";
  if (!normalized.endsWith(".service")) {
    return undefined;
  }
  if (
    normalized.startsWith("/etc/systemd/") ||
    normalized.startsWith("/usr/lib/systemd/") ||
    normalized.startsWith("/lib/systemd/")
  ) {
    return "system";
  }
  return "user";
}

function findGatewayEntrypoint(programArguments: readonly string[]): string | undefined {
  const gatewayIndex = programArguments.indexOf("gateway");
  if (gatewayIndex <= 0) {
    return undefined;
  }
  return programArguments[gatewayIndex - 1];
}

async function tryRealpath(value: string | undefined): Promise<string | undefined> {
  if (!value) {
    return undefined;
  }
  const resolved = path.resolve(value);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function isSourceCheckoutRoot(candidate: string): Promise<boolean> {
  const hasRepoMarker =
    (await pathExists(path.join(candidate, ".git"))) ||
    (await pathExists(path.join(candidate, "pnpm-workspace.yaml")));
  if (!hasRepoMarker) {
    return false;
  }
  return (
    (await pathExists(path.join(candidate, "src"))) &&
    (await pathExists(path.join(candidate, "extensions")))
  );
}

async function resolveOpenClawPackageRoot(entrypoint: string): Promise<string | undefined> {
  let current = path.dirname(path.resolve(entrypoint));
  for (let depth = 0; depth < 8; depth += 1) {
    const packageJson = path.join(current, "package.json");
    if (await pathExists(packageJson)) {
      const name = await readPackageName(current);
      if (name === "openclaw") {
        return current;
      }
    }
    const next = path.dirname(current);
    if (next === current) {
      return undefined;
    }
    current = next;
  }
  return undefined;
}

export async function summarizeGatewayServiceLayout(
  command: GatewayServiceCommandConfig | null,
): Promise<GatewayServiceLayoutSummary | undefined> {
  if (!command) {
    return undefined;
  }
  const sourcePath = command.sourcePath?.trim() || undefined;
  const entrypoint = findGatewayEntrypoint(command.programArguments);
  const [sourcePathReal, entrypointReal] = await Promise.all([
    tryRealpath(sourcePath),
    tryRealpath(entrypoint),
  ]);
  const packageRoot = entrypointReal ? await resolveOpenClawPackageRoot(entrypointReal) : undefined;
  const packageRootReal = await tryRealpath(packageRoot);
  const packageVersion = packageRoot
    ? ((await readPackageVersion(packageRoot)) ?? undefined)
    : undefined;
  const entrypointSourceCheckout = packageRootReal
    ? await isSourceCheckoutRoot(packageRootReal)
    : undefined;

  return {
    execStart: formatExecStart(command.programArguments),
    ...(sourcePath ? { sourcePath } : {}),
    ...(sourcePathReal ? { sourcePathReal } : {}),
    ...(sourcePath ? { sourceScope: resolveSystemdScopeFromServicePath(sourcePath) } : {}),
    ...(entrypoint ? { entrypoint } : {}),
    ...(entrypointReal ? { entrypointReal } : {}),
    ...(packageRoot ? { packageRoot } : {}),
    ...(packageRootReal ? { packageRootReal } : {}),
    ...(packageVersion ? { packageVersion } : {}),
    ...(entrypointSourceCheckout !== undefined ? { entrypointSourceCheckout } : {}),
  };
}
