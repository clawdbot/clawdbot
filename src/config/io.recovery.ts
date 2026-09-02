import { persistBoundedClobberedConfigSnapshot } from "./io.clobber-snapshot.js";
import type { ConfigIoContext } from "./io.context.js";
import {
  parseConfigJson5,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
} from "./io.read-helpers.js";
import type { ConfigFileSnapshot } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

function findJsonRootSuffix(
  raw: string,
  json5: { parse: (value: string) => unknown },
): { raw: string; parsed: unknown } | null {
  if (/^\s*(?:\{|\[)/.test(raw)) {
    return null;
  }
  let offset = 0;
  while (offset < raw.length) {
    const nextNewline = raw.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? raw.length : nextNewline + 1;
    const line = raw.slice(offset, lineEnd);
    if (/^\s*(?:\{|\[)/.test(line)) {
      const candidate = raw.slice(offset);
      const parsed = parseConfigJson5(candidate, json5);
      return parsed.ok ? { raw: candidate, parsed: parsed.parsed } : null;
    }
    offset = lineEnd;
  }
  return null;
}

function warnOnConfigPermissionHardeningFailure(params: {
  context: ConfigIoContext;
  detail: string;
  error: unknown;
}): void {
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  params.context.deps.logger.warn(
    `Config permission hardening failed (${params.detail}): ${params.context.configPath}: ${message}`,
  );
}

async function persistPrefixedConfigRecovery(params: {
  context: ConfigIoContext;
  originalRaw: string;
  recoveredRaw: string;
}): Promise<void> {
  const { context } = params;
  const observedAt = new Date().toISOString();
  const clobberedPath = await persistBoundedClobberedConfigSnapshot({
    deps: context.deps,
    configPath: context.configPath,
    raw: params.originalRaw,
    observedAt,
  });
  await context.deps.fs.promises.writeFile(context.configPath, params.recoveredRaw, {
    encoding: "utf-8",
    mode: 0o600,
  });
  await context.deps.fs.promises.chmod?.(context.configPath, 0o600).catch((error: unknown) => {
    warnOnConfigPermissionHardeningFailure({ context, detail: "prefix recovery", error });
  });
  context.deps.logger.warn(
    `Config auto-stripped non-JSON prefix: ${context.configPath}` +
      (clobberedPath ? ` (original saved as ${clobberedPath})` : ""),
  );
}

export async function recoverConfigFromJsonRootSuffixWithContext(
  context: ConfigIoContext,
  snapshot: ConfigFileSnapshot,
): Promise<boolean> {
  if (!snapshot.exists || snapshot.valid || typeof snapshot.raw !== "string") {
    return false;
  }
  const suffixRecovery = findJsonRootSuffix(snapshot.raw, context.deps.json5);
  if (!suffixRecovery) {
    return false;
  }
  let resolved: unknown;
  try {
    resolved = resolveConfigIncludesForRead(
      suffixRecovery.parsed,
      context.configPath,
      context.deps,
    );
  } catch {
    return false;
  }
  const resolution = resolveConfigForRead(
    resolved,
    context.deps.env,
    context.deps.lowerPrecedenceEnv,
  );
  const validated = validateConfigObjectWithPlugins(resolution.resolvedConfigRaw, {
    env: context.deps.env,
    sourceRaw: suffixRecovery.parsed,
  });
  if (!validated.ok) {
    return false;
  }
  await persistPrefixedConfigRecovery({
    context,
    originalRaw: snapshot.raw,
    recoveredRaw: suffixRecovery.raw,
  });
  return true;
}
