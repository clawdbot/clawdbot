import crypto from "node:crypto";
import type { CodexAppServerClient } from "./client.js";
import {
  isJsonObject,
  type CodexConfigRequirementsReadResponse,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import { fingerprintJsonObject } from "./thread-fingerprints.js";

// Registry features can expose tools directly or re-enable their owning feature.
// One list owns both the thread deny patch and requirement pin rejection.
export const CODEX_RING_ZERO_RESTRICTED_FEATURES = new Set([
  "apps",
  "artifact",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "chronicle",
  "code_mode",
  "code_mode_only",
  "computer_use",
  "context_management",
  "current_time_reminder",
  "default_mode_request_user_input",
  "deferred_executor",
  "goals",
  "hooks",
  "image_generation",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "request_permissions_tool",
  "skill_search",
  "shell_tool",
  "standalone_web_search",
  "token_budget",
  "unified_exec",
  "view_image",
  "web_search_cached",
  "web_search_request",
  "workspace_dependencies",
]);

const CODEX_RING_ZERO_RESTRICTED_FEATURE_ALIASES = new Map<string, string>([
  ["connectors", "apps"],
  ["imagegenext", "image_generation"],
  ["collab", "multi_agent"],
  ["memory_tool", "memories"],
  ["telepathy", "chronicle"],
  ["codex_hooks", "hooks"],
]);

export async function assertCodexManagedRequirementsDoNotOverrideToolPolicy(
  client: Pick<CodexAppServerClient, "request">,
  options: {
    cwd?: string;
    protectedNativeContext?: boolean;
    restrictedToolSurface: boolean;
    requiredNativeShell?: boolean;
    additionalDeniedFeatures?: readonly string[];
    allowedManagedRequirementsFingerprint?: string;
    allowConfiguredManagedHooks?: boolean;
  },
  signal?: AbortSignal,
): Promise<{ config: JsonObject; fingerprint: string } | undefined> {
  const requirements = await readCodexManagedRequirements(client, signal);
  const managedRequirementsFingerprint = buildCodexManagedRequirementsFingerprint(requirements);
  const managedRequirementsMatch =
    options.allowedManagedRequirementsFingerprint !== undefined &&
    managedRequirementsFingerprint === options.allowedManagedRequirementsFingerprint;
  const additionalDeniedFeatures = new Set(options.additionalDeniedFeatures);
  const managedHooksAllowed =
    !additionalDeniedFeatures.has("hooks") &&
    (managedRequirementsMatch || options.allowConfiguredManagedHooks === true);
  if (options.allowedManagedRequirementsFingerprint !== undefined && !managedRequirementsMatch) {
    throw new Error(
      "Codex managed requirements changed since this automation was authorized; reauthorize the automation from a fresh owner turn",
    );
  }
  if (requirements === null) {
    return undefined;
  }
  let hasManagedHooks = false;
  if (options.restrictedToolSurface) {
    for (const key of ["hooks", "managedHooks", "managed_hooks"] as const) {
      const hooks = requirements[key];
      if (hooks === undefined || hooks === null) {
        continue;
      }
      if (!isJsonObject(hooks)) {
        throw new Error("Codex configRequirements/read returned invalid managed hooks");
      }
      hasManagedHooks ||= hasNonEmptyJsonValue(hooks);
      if (hasManagedHooks && !managedHooksAllowed) {
        throw new Error("Codex restricted tool surface cannot override managed hooks");
      }
    }
  }
  let hooksRequired = false;
  for (const key of ["featureRequirements", "feature_requirements"] as const) {
    const featureRequirements = requirements[key];
    if (featureRequirements === undefined || featureRequirements === null) {
      continue;
    }
    if (!isJsonObject(featureRequirements)) {
      throw new Error("Codex configRequirements/read returned invalid feature requirements");
    }
    for (const [feature, enabled] of Object.entries(featureRequirements)) {
      if (typeof enabled !== "boolean") {
        throw new Error("Codex configRequirements/read returned invalid feature requirements");
      }
      const canonicalFeature = CODEX_RING_ZERO_RESTRICTED_FEATURE_ALIASES.get(feature) ?? feature;
      if (options.requiredNativeShell && canonicalFeature === "shell_tool" && !enabled) {
        throw new Error(
          "Codex native code mode requires shell_tool, but managed requirements disable it. Ask your administrator to allow the shell, or select a tool policy that disables native code mode; no automation authority was captured.",
        );
      }
      const deniedByToolPolicy =
        (options.restrictedToolSurface &&
          CODEX_RING_ZERO_RESTRICTED_FEATURES.has(canonicalFeature)) ||
        additionalDeniedFeatures.has(canonicalFeature);
      if (canonicalFeature === "hooks" && managedHooksAllowed) {
        hooksRequired ||= enabled;
        continue;
      }
      if (enabled && deniedByToolPolicy) {
        throw new Error(`Codex tool policy cannot override required feature ${feature}`);
      }
    }
  }
  if (
    !options.restrictedToolSurface ||
    !managedHooksAllowed ||
    (!hasManagedHooks && !hooksRequired)
  ) {
    return undefined;
  }
  if (!options.cwd) {
    throw new Error("Codex managed hook admission requires the native working directory");
  }
  const response = await client.request<unknown>("hooks/list", { cwds: [options.cwd] }, { signal });
  const entry =
    isJsonObject(response) && Array.isArray(response.data) && response.data.length === 1
      ? response.data[0]
      : undefined;
  if (
    !isJsonObject(entry) ||
    entry.cwd !== options.cwd ||
    !Array.isArray(entry.hooks) ||
    !Array.isArray(entry.warnings) ||
    entry.warnings.length !== 0 ||
    !Array.isArray(entry.errors) ||
    entry.errors.length !== 0
  ) {
    throw new Error("Codex hooks/list could not verify the restricted hook inventory");
  }
  const keys = new Set<string>();
  const ordinaryKeys: string[] = [];
  let managedHookFound = false;
  for (const hook of entry.hooks) {
    if (
      !isJsonObject(hook) ||
      typeof hook.key !== "string" ||
      !hook.key.trim() ||
      hook.key !== hook.key.trim() ||
      keys.has(hook.key) ||
      typeof hook.isManaged !== "boolean" ||
      typeof hook.enabled !== "boolean" ||
      (hook.isManaged && (!hook.enabled || hook.trustStatus !== "managed"))
    ) {
      throw new Error("Codex hooks/list returned invalid hook metadata");
    }
    keys.add(hook.key);
    if (hook.isManaged) {
      managedHookFound = true;
    } else {
      ordinaryKeys.push(hook.key);
    }
  }
  // Native list_hooks returns an empty inventory when the feature is disabled.
  // Never activate it from that empty inventory unless requirements already do.
  if (!hooksRequired && entry.hooks.length === 0) {
    return undefined;
  }
  if (hasManagedHooks && !managedHookFound) {
    throw new Error("Codex hooks/list did not verify the required managed hooks");
  }
  if (!options.protectedNativeContext && requirements.allowManagedHooksOnly !== true) {
    throw new Error(
      "Codex cannot admit managed hooks for an unprotected restricted runtime. Use protected native configuration in a sandbox runtime or administrator allow_managed_hooks_only policy.",
    );
  }
  // Per-key state is safe only when model tools cannot mutate its config sources,
  // or native managed-only discovery rejects ordinary sources on every refresh.
  // Trusted operator edits are outside the model-writable configuration boundary.
  // Native SessionFlags hook state overrides User state; managed handlers ignore
  // disablement. Keep opaque keys nested because native config splits dotted paths.
  return {
    config: {
      "features.hooks": true,
      hooks: { state: Object.fromEntries(ordinaryKeys.map((key) => [key, { enabled: false }])) },
    },
    // Inventory includes managed handlers from config layers as well as requirements.
    // Persist only their digest; command changes must invalidate loaded-thread reuse.
    fingerprint: crypto
      .createHash("sha256")
      .update(
        fingerprintJsonObject({ version: 1, managedRequirementsFingerprint, hooks: entry.hooks }),
      )
      .digest("hex"),
  };
}

/** Hashes the exact managed requirements without retaining their hook commands or policy details. */
function buildCodexManagedRequirementsFingerprint(requirements: JsonObject | null): string {
  const fingerprint = fingerprintJsonObject({ version: 1, requirements });
  return crypto.createHash("sha256").update(fingerprint).digest("hex");
}

/** Reads and fingerprints the exact managed requirements active on this app-server. */
export async function readCodexManagedRequirementsFingerprint(
  client: Pick<CodexAppServerClient, "request">,
  signal?: AbortSignal,
): Promise<string> {
  return buildCodexManagedRequirementsFingerprint(
    await readCodexManagedRequirements(client, signal),
  );
}

async function readCodexManagedRequirements(
  client: Pick<CodexAppServerClient, "request">,
  signal?: AbortSignal,
): Promise<JsonObject | null> {
  const response: CodexConfigRequirementsReadResponse = await client.request(
    "configRequirements/read",
    undefined,
    { signal },
  );
  if (!isJsonObject(response) || !Object.hasOwn(response, "requirements")) {
    throw new Error("Codex configRequirements/read returned an invalid response");
  }
  if (response.requirements !== null && !isJsonObject(response.requirements)) {
    throw new Error("Codex configRequirements/read returned invalid requirements");
  }
  return response.requirements;
}

function hasNonEmptyJsonValue(value: JsonValue): boolean {
  if (value === null || value === false || value === "") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.values(value).some(hasNonEmptyJsonValue);
  }
  return true;
}
