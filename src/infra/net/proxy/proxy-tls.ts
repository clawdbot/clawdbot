import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ProxyConfig } from "../../../config/zod-schema.proxy.js";

export type ManagedProxyTlsOptions = Readonly<{
  ca?: string;
}>;

function normalizeOptionalPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function formatReadError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isHttpsProxyUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function resolveManagedProxyCaFile(params: {
  config?: ProxyConfig;
  caFileOverride?: string;
}): string | undefined {
  return (
    normalizeOptionalPath(params.caFileOverride) ??
    normalizeOptionalPath(params.config?.tls?.caFile)
  );
}

export function resolveManagedProxyCaFileForUrl(params: {
  proxyUrl: string | undefined;
  config?: ProxyConfig;
  caFileOverride?: string;
}): string | undefined {
  if (!isHttpsProxyUrl(params.proxyUrl)) {
    return undefined;
  }
  return resolveManagedProxyCaFile({
    config: params.config,
    caFileOverride: params.caFileOverride,
  });
}

export async function loadManagedProxyTlsOptions(
  caFile: string | undefined,
): Promise<ManagedProxyTlsOptions | undefined> {
  if (!caFile) {
    return undefined;
  }
  try {
    return { ca: await readFile(caFile, "utf8") };
  } catch (err) {
    throw new Error(`proxy CA file could not be read (${caFile}): ${formatReadError(err)}`, {
      cause: err,
    });
  }
}

export function loadManagedProxyTlsOptionsSync(
  caFile: string | undefined,
): ManagedProxyTlsOptions | undefined {
  if (!caFile) {
    return undefined;
  }
  try {
    return { ca: readFileSync(caFile, "utf8") };
  } catch (err) {
    throw new Error(`proxy CA file could not be read (${caFile}): ${formatReadError(err)}`, {
      cause: err,
    });
  }
}
