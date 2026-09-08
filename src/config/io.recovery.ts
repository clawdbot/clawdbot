import path from "node:path";
import { replaceFileAtomic } from "../infra/replace-file.js";
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
  // Recovery must publish by rename; a copy fallback can truncate the live config.
  await replaceFileAtomic({
    filePath: context.configPath,
    content: params.recoveredRaw,
    dirMode: 0o700,
    mode: 0o600,
    tempPrefix: path.basename(context.configPath),
    fileSystem: context.deps.fs,
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
    ...context.pathResolution,
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
