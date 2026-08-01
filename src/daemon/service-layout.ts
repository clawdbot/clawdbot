/** Summarizes installed service command paths and OpenClaw package layout. */
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../infra/fs-safe.js";
import { readPackageName, readPackageVersion } from "../infra/package-json.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";

/** Summary of the installed gateway service command and package layout. */
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

function resolveGatewayServiceEntrypoint(command: GatewayServiceCommandConfig): string | undefined {
  const gatewayIndex = command.programArguments.indexOf("gateway");
  if (gatewayIndex <= 0) {
    return undefined;
  }
  const entrypoint = command.programArguments[gatewayIndex - 1];
  if (!entrypoint) {
    return undefined;
  }
  if (path.isAbsolute(entrypoint) || path.win32.isAbsolute(entrypoint)) {
    return entrypoint;
  }
  const workingDirectory = command.workingDirectory?.trim();
  if (!workingDirectory) {
    return undefined;
  }
  if (path.isAbsolute(workingDirectory)) {
    return path.resolve(workingDirectory, entrypoint);
  }
  if (path.win32.isAbsolute(workingDirectory)) {
    return path.win32.resolve(workingDirectory, entrypoint);
  }
  return undefined;
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
  // Installed dist entrypoints can sit several levels below package root in
  // pnpm layouts; bound the walk to avoid scanning arbitrary filesystem depth.
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
  // Service managers resolve relative commands against their configured
  // working directory; without an absolute base, ownership is ambiguous.
  const entrypoint = resolveGatewayServiceEntrypoint(command);
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
