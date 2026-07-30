import { readProviderJsonResponse } from "../agents/provider-http-errors.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  parseOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../state/openclaw-schema-versions.js";
import { buildTimeoutAbortSignal } from "../utils/fetch-timeout.js";

type NpmPackageTargetStatus = {
  target: string;
  version: string | null;
  nodeEngine: string | null;
  schemaVersions?: OpenClawSchemaVersions;
  error?: string;
};

export type NpmMetadataCommandRunner = (
  argv: string[],
  options: {
    timeoutMs: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    maxOutputBytes?: number;
  },
) => Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
}>;

function toOptionalTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseNpmPackageTargetMetadata(raw: string): {
  version: string | null;
  nodeEngine: string | null;
  schemaVersions?: OpenClawSchemaVersions;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim()) as unknown;
  } catch (err) {
    throw new Error(`npm view returned invalid JSON: ${String(err)}`, { cause: err });
  }
  // npm 12 wraps `npm view --json` results in a singleton array.
  const entry = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { version: null, nodeEngine: null };
  }
  const rec = entry as Record<string, unknown>;
  const engines = rec.engines && typeof rec.engines === "object" ? rec.engines : null;
  const nodeEngine =
    toOptionalTrimmedString(rec["engines.node"]) ??
    (engines ? toOptionalTrimmedString((engines as Record<string, unknown>).node) : null);
  const openclaw = rec.openclaw && typeof rec.openclaw === "object" ? rec.openclaw : null;
  const schemaVersions =
    parseOpenClawSchemaVersions(rec["openclaw.schemaVersions"]) ??
    (openclaw
      ? parseOpenClawSchemaVersions((openclaw as Record<string, unknown>).schemaVersions)
      : undefined);
  return {
    version: toOptionalTrimmedString(rec.version),
    nodeEngine,
    ...(schemaVersions ? { schemaVersions } : {}),
  };
}

function formatNpmViewError(res: { stdout: string; stderr: string }): string {
  const raw = (res.stderr.trim() || res.stdout.trim()).split("\n").slice(-3).join("\n");
  return raw ? `npm view failed: ${raw}` : "npm view failed";
}

function packageTargetSpec(params: { target: string; spec?: string }): string {
  const spec = params.spec?.trim();
  return spec || `openclaw@${params.target.trim() || "latest"}`;
}

const PUBLIC_NPM_REGISTRY_URL = "https://registry.npmjs.org/";
const PUBLIC_NPM_PACKAGE_NAME = "openclaw";

function npmRegistryTargetUrl(params: {
  registryUrl: string;
  packageName: string;
  target: string;
}): string {
  const baseUrl = params.registryUrl.endsWith("/") ? params.registryUrl : `${params.registryUrl}/`;
  return new URL(
    `${encodeURIComponent(params.packageName)}/${encodeURIComponent(params.target)}`,
    baseUrl,
  ).toString();
}

async function fetchNpmPackageTargetStatusFromRegistry(params: {
  target: string;
  timeoutMs: number;
  registryUrl?: string;
  packageName?: string;
}): Promise<NpmPackageTargetStatus> {
  const url = npmRegistryTargetUrl({
    registryUrl: params.registryUrl ?? PUBLIC_NPM_REGISTRY_URL,
    packageName: params.packageName ?? PUBLIC_NPM_PACKAGE_NAME,
    target: params.target,
  });
  const { signal, cleanup } = buildTimeoutAbortSignal({
    timeoutMs: Math.max(250, params.timeoutMs),
    operation: "npm-registry-update-check",
    url,
  });
  let res: Response | undefined;
  try {
    res = await fetch(url, { signal });
    if (!res.ok) {
      return {
        target: params.target,
        version: null,
        nodeEngine: null,
        error: `HTTP ${res.status}`,
      };
    }
    // Keep the deadline active through body consumption. Fetch resolves at
    // headers, so clearing it earlier would leave a stalled registry body unbounded.
    const json = await readProviderJsonResponse<{
      version?: unknown;
      engines?: { node?: unknown };
      openclaw?: { schemaVersions?: unknown };
    }>(res, "npm package target status");
    const schemaVersions = parseOpenClawSchemaVersions(json.openclaw?.schemaVersions);
    return {
      target: params.target,
      version: toOptionalTrimmedString(json.version),
      nodeEngine: toOptionalTrimmedString(json.engines?.node),
      ...(schemaVersions ? { schemaVersions } : {}),
    };
  } catch (err) {
    return { target: params.target, version: null, nodeEngine: null, error: String(err) };
  } finally {
    if (res?.bodyUsed !== true) {
      await res?.body?.cancel().catch(() => undefined);
    }
    cleanup();
  }
}

export async function fetchNpmPackageTargetStatus(params: {
  target: string;
  timeoutMs?: number;
  spec?: string;
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: NpmMetadataCommandRunner;
  registryUrl?: string;
  packageName?: string;
}): Promise<NpmPackageTargetStatus> {
  const timeoutMs = params.timeoutMs ?? 3500;
  const target = params.target;
  if (!params.command && !params.runCommand) {
    return await fetchNpmPackageTargetStatusFromRegistry({
      target,
      timeoutMs,
      registryUrl: params.registryUrl,
      packageName: params.packageName,
    });
  }
  const runCommand = params.runCommand ?? runCommandWithTimeout;
  try {
    const res = await runCommand(
      [
        params.command ?? "npm",
        "view",
        packageTargetSpec({ target, spec: params.spec }),
        "version",
        "engines.node",
        "openclaw.schemaVersions",
        "--json",
        "--global",
      ],
      {
        timeoutMs: Math.max(250, timeoutMs),
        cwd: params.cwd,
        env: params.env,
        maxOutputBytes: 1024 * 1024,
      },
    );
    if (res.code !== 0) {
      return {
        target,
        version: null,
        nodeEngine: null,
        error: formatNpmViewError(res),
      };
    }
    const { version, nodeEngine, schemaVersions } = parseNpmPackageTargetMetadata(res.stdout);
    return { target, version, nodeEngine, ...(schemaVersions ? { schemaVersions } : {}) };
  } catch (err) {
    return { target, version: null, nodeEngine: null, error: String(err) };
  }
}
