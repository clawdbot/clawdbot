import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isNonSecretApiKeyMarker,
  isSecretRefHeaderValueMarker,
} from "../agents/model-auth-markers.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { resolveStateDir, type OpenClawConfig } from "../config/config.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { resolveSecretInputRef, type SecretRef } from "../config/types.secrets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { iterateAuthProfileCredentials } from "./auth-profiles-scan.js";
import { createSecretsConfigIO } from "./config-io.js";
import { getSkippedExecRefStaticError, selectRefsForExecPolicy } from "./exec-resolution-policy.js";
import { listKnownSecretEnvVarNames } from "./provider-env-vars.js";
import { secretRefKey } from "./ref-contract.js";
import {
  isProviderScopedSecretResolutionError,
  resolveSecretRefValue,
  resolveSecretRefValues,
  type SecretRefResolveCache,
} from "./resolve.js";
import {
  hasConfiguredPlaintextSecretValue,
  isExpectedResolvedSecretValue,
} from "./secret-value.js";
import { isNonEmptyString, isRecord } from "./shared.js";
import {
  listAgentModelsJsonPaths,
  listAuthProfileStorePaths,
  listLegacyAuthJsonPaths,
  parseEnvAssignmentValue,
  readJsonObjectIfExists,
} from "./storage-scan.js";
import { discoverConfigSecretTargets } from "./target-registry.js";

export type SecretsAuditCode =
  | "PLAINTEXT_FOUND"
  | "REF_UNRESOLVED"
  | "REF_SHADOWED"
  | "LEGACY_RESIDUE";

export type SecretsAuditSeverity = "info" | "warn" | "error"; // pragma: allowlist secret

export type SecretsAuditFinding = {
  code: SecretsAuditCode;
  severity: SecretsAuditSeverity;
  file: string;
  jsonPath: string;
  message: string;
  provider?: string;
  profileId?: string;
};

export type SecretsAuditStatus = "clean" | "findings" | "unresolved"; // pragma: allowlist secret

export type SecretsAuditReport = {
  version: 1;
  status: SecretsAuditStatus;
  resolution: {
    refsChecked: number;
    skippedExecRefs: number;
    resolvabilityComplete: boolean;
  };
  filesScanned: string[];
  summary: {
    plaintextCount: number;
    unresolvedRefCount: number;
    shadowedRefCount: number;
    legacyResidueCount: number;
  };
  findings: SecretsAuditFinding[];
};

type RefAssignment = {
  file: string;
  path: string;
  ref: SecretRef;
  expected: "string" | "string-or-object";
  provider?: string;
};

type ProviderAuthState = {
  hasUsableStaticOrOAuth: boolean;
  modes: Set<"api_key" | "token" | "oauth">;
};

type SecretDefaults = {
  env?: string;
  file?: string;
  exec?: string;
};

type AuditCollector = {
  findings: SecretsAuditFinding[];
  refAssignments: RefAssignment[];
  configProviderRefPaths: Map<string, string[]>;
  authProviderState: Map<string, ProviderAuthState>;
  filesScanned: Set<string>;
};

const REF_RESOLVE_FALLBACK_CONCURRENCY = 8;
const MAX_AUDIT_MODELS_JSON_BYTES = 5 * 1024 * 1024;
const ALWAYS_SENSITIVE_MODEL_PROVIDER_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "auth-token",
  "x-access-token",
  "access-token",
  "x-secret-key",
  "secret-key",
]);
const SENSITIVE_MODEL_PROVIDER_HEADER_NAME_FRAGMENTS = [
  "api-key",
  "apikey",
  "token",
  "secret",
  "password",
  "credential",
];

function isLikelySensitiveModelProviderHeaderName(value: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (!normalized) {
    return false;
  }
  if (ALWAYS_SENSITIVE_MODEL_PROVIDER_HEADER_NAMES.has(normalized)) {
    return true;
  }
  return SENSITIVE_MODEL_PROVIDER_HEADER_NAME_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment),
  );
}

function addFinding(collector: AuditCollector, finding: SecretsAuditFinding): void {
  collector.findings.push(finding);
}

function collectProviderRefPath(
  collector: AuditCollector,
  providerId: string,
  configPath: string,
): void {
  const key = normalizeProviderId(providerId);
  const existing = collector.configProviderRefPaths.get(key);
  if (existing) {
    existing.push(configPath);
    return;
  }
  collector.configProviderRefPaths.set(key, [configPath]);
}

function trackAuthProviderState(
  collector: AuditCollector,
  provider: string,
  mode: "api_key" | "token" | "oauth",
): void {
  const key = normalizeProviderId(provider);
  const existing = collector.authProviderState.get(key);
  if (existing) {
    existing.hasUsableStaticOrOAuth = true;
    existing.modes.add(mode);
    return;
  }
  collector.authProviderState.set(key, {
    hasUsableStaticOrOAuth: true,
    modes: new Set([mode]),
  });
}

function collectEnvPlaintext(params: { envPath: string; collector: AuditCollector }): void {
  if (!fs.existsSync(params.envPath)) {
    return;
  }
  params.collector.filesScanned.add(params.envPath);
  const knownKeys = new Set(listKnownSecretEnvVarNames());
  const raw = fs.readFileSync(params.envPath, "utf8");
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1] ?? "";
    if (!knownKeys.has(key)) {
      continue;
    }
    const value = parseEnvAssignmentValue(match[2] ?? "");
    if (!value) {
      continue;
    }
    addFinding(params.collector, {
      code: "PLAINTEXT_FOUND",
      severity: "warn",
      file: params.envPath,
      jsonPath: `$env.${key}`,
      message: `Potential secret found in .env (${key}).`,
    });
  }
}

function collectConfigSecrets(params: {
  config: OpenClawConfig;
  configPath: string;
  collector: AuditCollector;
}): void {
  const defaults = params.config.secrets?.defaults;
  for (const target of discoverConfigSecretTargets(params.config)) {
    if (!target.entry.includeInAudit) {
      continue;
    }
    const { ref } = resolveSecretInputRef({
      value: target.value,
      refValue: target.refValue,
      defaults,
    });
    if (ref) {
      params.collector.refAssignments.push({
        file: params.configPath,
        path: target.path,
        ref,
        expected: target.entry.expectedResolvedValue,
        provider: target.providerId,
      });
      if (target.entry.trackProviderShadowing && target.providerId) {
        collectProviderRefPath(params.collector, target.providerId, target.path);
      }
      continue;
    }

    const hasPlaintext = hasConfiguredPlaintextSecretValue(
      target.value,
      target.entry.expectedResolvedValue,
    );
    if (
      target.entry.id === "models.providers.*.headers.*" &&
      !isLikelySensitiveModelProviderHeaderName(target.pathSegments.at(-1) ?? "")
    ) {
      continue;
    }
    if (!hasPlaintext) {
      continue;
    }
    addFinding(params.collector, {
      code: "PLAINTEXT_FOUND",
      severity: "warn",
      file: params.configPath,
      jsonPath: target.path,
      message: `${target.path} is stored as plaintext.`,
      provider: target.providerId,
    });
  }
}

function collectAuthStoreSecrets(params: {
  authStorePath: string;
  collector: AuditCollector;
  defaults?: SecretDefaults;
}): void {
  if (!fs.existsSync(params.authStorePath)) {
    return;
  }
  params.collector.filesScanned.add(params.authStorePath);
  const parsedResult = readJsonObjectIfExists(params.authStorePath);
  if (parsedResult.error) {
    addFinding(params.collector, {
      code: "REF_UNRESOLVED",
      severity: "error",
      file: params.authStorePath,
      jsonPath: "<root>",
      message: `Invalid JSON in auth-profiles store: ${parsedResult.error}`,
    });
    return;
  }
  const parsed = parsedResult.value;
  if (!parsed || !isRecord(parsed.profiles)) {
    return;
  }
  for (const entry of iterateAuthProfileCredentials(parsed.profiles)) {
    if (entry.kind === "api_key" || entry.kind === "token") {
      const { ref } = resolveSecretInputRef({
        value: entry.value,
        refValue: entry.refValue,
        defaults: params.defaults,
      });
      const authoredValueRef = coerceSecretRef(entry.value, params.defaults);
      if (ref) {
        params.collector.refAssignments.push({
          file: params.authStorePath,
          path: `profiles.${entry.profileId}.${entry.valueField}`,
          ref,
          expected: "string",
          provider: entry.provider,
        });
        trackAuthProviderState(params.collector, entry.provider, entry.kind);
      }
      if (authoredValueRef) {
        continue;
      }
      if (isNonEmptyString(entry.value)) {
        addFinding(params.collector, {
          code: "PLAINTEXT_FOUND",
          severity: "warn",
          file: params.authStorePath,
          jsonPath: `profiles.${entry.profileId}.${entry.valueField}`,
          message:
            entry.kind === "api_key"
              ? "Auth profile API key is stored as plaintext."
              : "Auth profile token is stored as plaintext.",
          provider: entry.provider,
          profileId: entry.profileId,
        });
        trackAuthProviderState(params.collector, entry.provider, entry.kind);
      }
      continue;
    }
    if (entry.hasAccess || entry.hasRefresh) {
      addFinding(params.collector, {
        code: "LEGACY_RESIDUE",
        severity: "info",
        file: params.authStorePath,
        jsonPath: `profiles.${entry.profileId}`,
        message: "OAuth credentials are present (out of scope for static SecretRef migration).",
        provider: entry.provider,
        profileId: entry.profileId,
      });
      trackAuthProviderState(params.collector, entry.provider, "oauth");
    }
  }
}

function collectAuthJsonResidue(params: { stateDir: string; collector: AuditCollector }): void {
  for (const authJsonPath of listLegacyAuthJsonPaths(params.stateDir)) {
    params.collector.filesScanned.add(authJsonPath);
    const parsedResult = readJsonObjectIfExists(authJsonPath);
    if (parsedResult.error) {
      addFinding(params.collector, {
        code: "REF_UNRESOLVED",
        severity: "error",
        file: authJsonPath,
        jsonPath: "<root>",
        message: `Invalid JSON in legacy auth.json: ${parsedResult.error}`,
      });
      continue;
    }
    const parsed = parsedResult.value;
    if (!parsed) {
      continue;
    }
    for (const [providerId, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        continue;
      }
      if (value.type === "api_key" && isNonEmptyString(value.key)) {
        addFinding(params.collector, {
          code: "LEGACY_RESIDUE",
          severity: "warn",
          file: authJsonPath,
          jsonPath: providerId,
          message: "Legacy auth.json contains static api_key credentials.",
          provider: providerId,
        });
      }
    }
  }
}

function collectModelsJsonSecrets(params: {
  modelsJsonPath: string;
  collector: AuditCollector;
}): void {
  if (!fs.existsSync(params.modelsJsonPath)) {
    return;
  }
  params.collector.filesScanned.add(params.modelsJsonPath);
  const parsedResult = readJsonObjectIfExists(params.modelsJsonPath, {
    requireRegularFile: true,
    maxBytes: MAX_AUDIT_MODELS_JSON_BYTES,
  });
  if (parsedResult.error) {
    addFinding(params.collector, {
      code: "REF_UNRESOLVED",
      severity: "error",
      file: params.modelsJsonPath,
      jsonPath: "<root>",
      message: `Invalid JSON in models.json: ${parsedResult.error}`,
    });
    return;
  }
  const parsed = parsedResult.value;
  if (!parsed || !isRecord(parsed.providers)) {
    return;
  }
  for (const [providerId, providerValue] of Object.entries(parsed.providers)) {
    if (!isRecord(providerValue)) {
      continue;
    }
    const apiKey = providerValue.apiKey;
    if (coerceSecretRef(apiKey)) {
      addFinding(params.collector, {
        code: "REF_UNRESOLVED",
        severity: "error",
        file: params.modelsJsonPath,
        jsonPath: `providers.${providerId}.apiKey`,
        message: "models.json contains an unresolved SecretRef object; regenerate models.json.",
        provider: providerId,
      });
    } else if (isNonEmptyString(apiKey) && !isNonSecretApiKeyMarker(apiKey)) {
      addFinding(params.collector, {
        code: "PLAINTEXT_FOUND",
        severity: "warn",
        file: params.modelsJsonPath,
        jsonPath: `providers.${providerId}.apiKey`,
        message: "models.json provider apiKey is stored as plaintext.",
        provider: providerId,
      });
    }

    const headers = isRecord(providerValue.headers) ? providerValue.headers : undefined;
    if (!headers) {
      continue;
    }
    for (const [headerKey, headerValue] of Object.entries(headers)) {
      const headerPath = `providers.${providerId}.headers.${headerKey}`;
      if (coerceSecretRef(headerValue)) {
        addFinding(params.collector, {
          code: "REF_UNRESOLVED",
          severity: "error",
          file: params.modelsJsonPath,
          jsonPath: headerPath,
          message:
            "models.json contains an unresolved SecretRef object for provider headers; regenerate models.json.",
          provider: providerId,
        });
        continue;
      }
      if (!isNonEmptyString(headerValue)) {
        continue;
      }
      if (isSecretRefHeaderValueMarker(headerValue)) {
        continue;
      }
      if (!isLikelySensitiveModelProviderHeaderName(headerKey)) {
        continue;
      }
      addFinding(params.collector, {
        code: "PLAINTEXT_FOUND",
        severity: "warn",
        file: params.modelsJsonPath,
        jsonPath: headerPath,
        message: "models.json provider header value is stored as plaintext.",
        provider: providerId,
      });
    }
  }
}

async function collectUnresolvedRefFindings(params: {
  collector: AuditCollector;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  allowExec: boolean;
}): Promise<{ refsChecked: number; skippedExecRefs: number }> {
  const cache: SecretRefResolveCache = {};
  const refsByProvider = new Map<string, Map<string, SecretRef>>();
  const skippedRefKeys = new Set<string>();
  let refsChecked = 0;
  let skippedExecRefs = 0;
  for (const assignment of params.collector.refAssignments) {
    const providerKey = `${assignment.ref.source}:${assignment.ref.provider}`;
    let refsForProvider = refsByProvider.get(providerKey);
    if (!refsForProvider) {
      refsForProvider = new Map<string, SecretRef>();
      refsByProvider.set(providerKey, refsForProvider);
    }
    refsForProvider.set(secretRefKey(assignment.ref), assignment.ref);
  }

  const resolvedByRefKey = new Map<string, unknown>();
  const errorsByRefKey = new Map<string, unknown>();

  for (const refsForProvider of refsByProvider.values()) {
    const refs = [...refsForProvider.values()];
    const selectedRefs = selectRefsForExecPolicy({
      refs,
      allowExec: params.allowExec,
    });
    if (selectedRefs.skippedExecRefs.length > 0) {
      skippedExecRefs += selectedRefs.skippedExecRefs.length;
      for (const ref of selectedRefs.skippedExecRefs) {
        skippedRefKeys.add(secretRefKey(ref));
        const staticError = getSkippedExecRefStaticError({
          ref,
          config: params.config,
        });
        if (staticError) {
          errorsByRefKey.set(secretRefKey(ref), new Error(staticError));
        }
      }
    }
    if (selectedRefs.refsToResolve.length === 0) {
      continue;
    }
    refsChecked += selectedRefs.refsToResolve.length;
    const provider = refs[0]?.provider;
    try {
      const resolved = await resolveSecretRefValues(selectedRefs.refsToResolve, {
        config: params.config,
        env: params.env,
        cache,
      });
      for (const [key, value] of resolved.entries()) {
        resolvedByRefKey.set(key, value);
      }
      continue;
    } catch (err) {
      if (provider && isProviderScopedSecretResolutionError(err)) {
        for (const ref of selectedRefs.refsToResolve) {
          errorsByRefKey.set(secretRefKey(ref), err);
        }
        continue;
      }
      // Fall back to per-ref resolution for provider-specific pinpoint errors.
    }

    const tasks = selectedRefs.refsToResolve.map(
      (ref) => async (): Promise<{ key: string; resolved: unknown }> => ({
        key: secretRefKey(ref),
        resolved: await resolveSecretRefValue(ref, {
          config: params.config,
          env: params.env,
          cache,
        }),
      }),
    );
    const fallback = await runTasksWithConcurrency({
      tasks,
      limit: Math.min(REF_RESOLVE_FALLBACK_CONCURRENCY, selectedRefs.refsToResolve.length),
      errorMode: "continue",
      onTaskError: (error, index) => {
        const ref = selectedRefs.refsToResolve[index];
        if (!ref) {
          return;
        }
        errorsByRefKey.set(secretRefKey(ref), error);
      },
    });
    for (const result of fallback.results) {
      if (!result) {
        continue;
      }
      resolvedByRefKey.set(result.key, result.resolved);
    }
  }

  for (const assignment of params.collector.refAssignments) {
    const key = secretRefKey(assignment.ref);
    if (skippedRefKeys.has(key) && !errorsByRefKey.has(key)) {
      continue;
    }
    const resolveErr = errorsByRefKey.get(key);
    if (resolveErr) {
      addFinding(params.collector, {
        code: "REF_UNRESOLVED",
        severity: "error",
        file: assignment.file,
        jsonPath: assignment.path,
        message: `Failed to resolve ${assignment.ref.source}:${assignment.ref.provider}:${assignment.ref.id} (${formatErrorMessage(resolveErr)}).`,
        provider: assignment.provider,
      });
      continue;
    }

    if (!resolvedByRefKey.has(key)) {
      addFinding(params.collector, {
        code: "REF_UNRESOLVED",
        severity: "error",
        file: assignment.file,
        jsonPath: assignment.path,
        message: `Failed to resolve ${assignment.ref.source}:${assignment.ref.provider}:${assignment.ref.id} (resolved value is missing).`,
        provider: assignment.provider,
      });
      continue;
    }

    const resolved = resolvedByRefKey.get(key);
    if (!isExpectedResolvedSecretValue(resolved, assignment.expected)) {
      addFinding(params.collector, {
        code: "REF_UNRESOLVED",
        severity: "error",
        file: assignment.file,
        jsonPath: assignment.path,
        message:
          assignment.expected === "string"
            ? `Failed to resolve ${assignment.ref.source}:${assignment.ref.provider}:${assignment.ref.id} (resolved value is not a non-empty string).`
            : `Failed to resolve ${assignment.ref.source}:${assignment.ref.provider}:${assignment.ref.id} (resolved value is not a string/object).`,
        provider: assignment.provider,
      });
    }
  }
  return {
    refsChecked,
    skippedExecRefs,
  };
}

function collectShadowingFindings(collector: AuditCollector): void {
  for (const [provider, paths] of collector.configProviderRefPaths.entries()) {
    const authState = collector.authProviderState.get(provider);
    if (!authState?.hasUsableStaticOrOAuth) {
      continue;
    }
    const modeText = [...authState.modes].join("/");
    for (const configPath of paths) {
      addFinding(collector, {
        code: "REF_SHADOWED",
        severity: "warn",
        file: "openclaw.json",
        jsonPath: configPath,
        message: `Auth profile credentials (${modeText}) take precedence for provider "${provider}", so this config ref may never be used.`,
        provider,
      });
    }
  }
}

function summarizeFindings(findings: SecretsAuditFinding[]): SecretsAuditReport["summary"] {
  return {
    plaintextCount: findings.filter((entry) => entry.code === "PLAINTEXT_FOUND").length,
    unresolvedRefCount: findings.filter((entry) => entry.code === "REF_UNRESOLVED").length,
    shadowedRefCount: findings.filter((entry) => entry.code === "REF_SHADOWED").length,
    legacyResidueCount: findings.filter((entry) => entry.code === "LEGACY_RESIDUE").length,
  };
}

export async function runSecretsAudit(
  params: {
    env?: NodeJS.ProcessEnv;
    allowExec?: boolean;
  } = {},
): Promise<SecretsAuditReport> {
  const env = params.env ?? process.env;
  const allowExec = Boolean(params.allowExec);
  const io = createSecretsConfigIO({ env });
  const snapshot = await io.readConfigFileSnapshot();
  const configPath = resolveUserPath(snapshot.path);
  const defaults = snapshot.valid ? snapshot.config.secrets?.defaults : undefined;

  const collector: AuditCollector = {
    findings: [],
    refAssignments: [],
    configProviderRefPaths: new Map(),
    authProviderState: new Map(),
    filesScanned: new Set([configPath]),
  };

  const stateDir = resolveStateDir(env, os.homedir);
  const envPath = path.join(resolveConfigDir(env, os.homedir), ".env");
  const config = snapshot.valid ? snapshot.config : ({} as OpenClawConfig);
  let resolution = {
    refsChecked: 0,
    skippedExecRefs: 0,
    resolvabilityComplete: true,
  };

  if (snapshot.valid) {
    collectConfigSecrets({
      config,
      configPath,
      collector,
    });
    for (const authStorePath of listAuthProfileStorePaths(config, stateDir)) {
      collectAuthStoreSecrets({
        authStorePath,
        collector,
        defaults,
      });
    }
    for (const modelsJsonPath of listAgentModelsJsonPaths(config, stateDir, env)) {
      collectModelsJsonSecrets({
        modelsJsonPath,
        collector,
      });
    }
    const unresolvedRefResult = await collectUnresolvedRefFindings({
      collector,
      config,
      env,
      allowExec,
    });
    resolution = {
      refsChecked: unresolvedRefResult.refsChecked,
      skippedExecRefs: unresolvedRefResult.skippedExecRefs,
      resolvabilityComplete: unresolvedRefResult.skippedExecRefs === 0,
    };
    collectShadowingFindings(collector);
  } else {
    addFinding(collector, {
      code: "REF_UNRESOLVED",
      severity: "error",
      file: configPath,
      jsonPath: "<root>",
      message: "Config is invalid; cannot validate secret references reliably.",
    });
  }

  collectEnvPlaintext({
    envPath,
    collector,
  });
  collectAuthJsonResidue({
    stateDir,
    collector,
  });

  const summary = summarizeFindings(collector.findings);
  const status: SecretsAuditStatus =
    summary.unresolvedRefCount > 0
      ? "unresolved"
      : collector.findings.length > 0
        ? "findings"
        : "clean";

  return {
    version: 1,
    status,
    resolution,
    filesScanned: [...collector.filesScanned].toSorted(),
    summary,
    findings: collector.findings,
  };
}

export function resolveSecretsAuditExitCode(report: SecretsAuditReport, check: boolean): number {
  if (report.summary.unresolvedRefCount > 0) {
    return 2;
  }
  if (check && report.findings.length > 0) {
    return 1;
  }
  return 0;
}
