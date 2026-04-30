// Path policy for file-transfer node.invoke calls.
//
// Default behavior is DENY. The operator must explicitly opt in by adding
// a config block to ~/.openclaw/openclaw.json under
// `plugins.entries.file-transfer.config.nodes`. Without a matching block,
// every file operation is rejected before reaching the node.
//
// Schema (informal):
//
//   "plugins": {
//     "entries": {
//       "file-transfer": {
//         "config": {
//           "nodes": {
//             "<nodeId-or-displayName>": {
//               "ask":              "off" | "on-miss" | "always",
//               "allowReadPaths":   ["~/Screenshots/**", "/tmp/**"],
//               "allowWritePaths":  ["~/Downloads/**"],
//               "denyPaths":        ["**/.ssh/**", "**/.aws/**"],
//               "maxBytes":         16777216,
//               "followSymlinks":   false
//             },
//             "*": { "ask": "on-miss" }
//           }
//         }
//       }
//     }
//   }
//
// `ask` modes:
//   off       — silent: allow if matched, deny if not (today's default)
//   on-miss   — silent allow if matched; prompt operator if not matched
//   always    — prompt operator on every call (denyPaths still hard-deny)
//
// `denyPaths` always wins, even in `ask: always`.
// `allow-always` from the prompt appends the path back into allowReadPaths /
// allowWritePaths via mutateConfigFile.
//
// `followSymlinks` (default false): if false, the node-side handler
// realpaths the requested path (or its parent for new-file writes) BEFORE
// any I/O, and refuses with SYMLINK_REDIRECT if it differs from the
// requested path. This stops a symlink in user-controlled territory
// (e.g. ~/Downloads/evil → /etc) from redirecting an allowed-looking path
// to a disallowed canonical location. Set to true to opt back into the
// looser "follow + post-flight check" behavior, e.g. on macOS where
// /var → /private/var trips the check for /var/folders paths.

import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";

export type FilePolicyKind = "read" | "write";
export type FilePolicyAskMode = "off" | "on-miss" | "always";

export type FilePolicyDecision =
  | { ok: true; reason: "matched-allow"; maxBytes?: number; followSymlinks: boolean }
  | {
      ok: true;
      reason: "ask-always";
      askMode: FilePolicyAskMode;
      maxBytes?: number;
      followSymlinks: boolean;
    }
  | {
      ok: false;
      code: "NO_POLICY" | "POLICY_DENIED";
      reason: string;
      askable: boolean;
      askMode?: FilePolicyAskMode;
      maxBytes?: number;
      followSymlinks?: boolean;
    };

type NodeFilePolicyConfig = {
  ask?: FilePolicyAskMode;
  allowReadPaths?: string[];
  allowWritePaths?: string[];
  denyPaths?: string[];
  maxBytes?: number;
  followSymlinks?: boolean;
};

type FilePolicyConfig = Record<string, NodeFilePolicyConfig>;

function asFilePolicyConfig(value: unknown): FilePolicyConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as FilePolicyConfig;
}

function readFilePolicyConfigFromPluginConfig(pluginConfig: unknown): FilePolicyConfig | null {
  if (!pluginConfig || typeof pluginConfig !== "object" || Array.isArray(pluginConfig)) {
    return null;
  }
  const nodes = (pluginConfig as { nodes?: unknown }).nodes;
  return asFilePolicyConfig(nodes);
}

function readPluginConfigFromRuntimeConfig(): Record<string, unknown> | null {
  const cfg = getRuntimeConfig();
  const plugins = (cfg as { plugins?: unknown }).plugins;
  if (!plugins || typeof plugins !== "object") {
    return null;
  }
  const entries = (plugins as { entries?: unknown }).entries;
  if (!entries || typeof entries !== "object") {
    return null;
  }
  const entry = (entries as Record<string, unknown>)["file-transfer"];
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const pluginConfig = (entry as { config?: unknown }).config;
  return pluginConfig && typeof pluginConfig === "object" && !Array.isArray(pluginConfig)
    ? (pluginConfig as Record<string, unknown>)
    : null;
}

function readFilePolicyConfig(pluginConfig?: Record<string, unknown>): FilePolicyConfig | null {
  return (
    readFilePolicyConfigFromPluginConfig(readPluginConfigFromRuntimeConfig()) ??
    readFilePolicyConfigFromPluginConfig(pluginConfig)
  );
}

function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(p === "~" ? 1 : 2));
  }
  return p;
}

function normalizeGlobs(patterns: string[] | undefined): string[] {
  if (!Array.isArray(patterns)) {
    return [];
  }
  return patterns
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => expandTilde(p.trim()));
}

function matchesAny(target: string, patterns: string[]): boolean {
  const normalizedTarget = target.replace(/\\/gu, "/");
  for (const pattern of patterns) {
    const normalizedPattern = pattern.replace(/\\/gu, "/");
    if (
      minimatch(target, pattern, { dot: true }) ||
      minimatch(normalizedTarget, normalizedPattern, { dot: true })
    ) {
      return true;
    }
  }
  return false;
}

function resolveNodePolicy(
  config: FilePolicyConfig,
  nodeId: string,
  nodeDisplayName?: string,
): { key: string; entry: NodeFilePolicyConfig } | null {
  const candidates = [nodeId, nodeDisplayName].filter(
    (k): k is string => typeof k === "string" && k.length > 0,
  );
  for (const key of candidates) {
    if (config[key]) {
      return { key, entry: config[key] };
    }
  }
  if (config["*"]) {
    return { key: "*", entry: config["*"] };
  }
  return null;
}

function normalizeAskMode(value: unknown): FilePolicyAskMode {
  if (value === "on-miss" || value === "always" || value === "off") {
    return value;
  }
  return "off";
}

/**
 * Evaluate whether (nodeId, kind, path) is permitted.
 *
 * Resolution order:
 *   1. No file-transfer config or no entry for this node → NO_POLICY (deny,
 *      not askable — operator hasn't opted in at all).
 *   2. denyPaths matches → POLICY_DENIED, not askable (hard deny).
 *   3. ask=always → ask-always (prompt every time).
 *   4. allowPaths matches → matched-allow (silent allow).
 *   5. ask=on-miss → POLICY_DENIED with askable=true.
 *   6. ask=off (or unset) → POLICY_DENIED, not askable.
 */
/**
 * Reject any path whose RAW string contains a ".." segment. Checking the
 * raw string (not the normalized form) is the point — `posix.normalize`
 * collapses "/allowed/../etc/passwd" to "/etc/passwd", which would defeat
 * the check. We want to flag the literal traversal sequence the agent
 * passed in, before any glob match runs.
 *
 * Without this, "/allowed/../etc/passwd" matches the glob "/allowed/**"
 * pre-realpath, so the node fetches the bytes before the post-flight
 * canonical-path check denies — too late, the bytes already crossed the
 * node→gateway boundary.
 *
 * Treats backslash and forward slash as equivalent separators so a Windows
 * node can't be hit with "C:\\allowed\\..\\Windows\\system.ini".
 */
function containsParentRefSegment(p: string): boolean {
  const unified = p.replace(/\\/gu, "/");
  return unified.split("/").includes("..");
}

export function evaluateFilePolicy(input: {
  nodeId: string;
  nodeDisplayName?: string;
  kind: FilePolicyKind;
  path: string;
  pluginConfig?: Record<string, unknown>;
}): FilePolicyDecision {
  // Reject literal traversal sequences before consulting any allow/deny
  // glob list. minimatch on the raw string can wrongly accept
  // "/allowed/../etc/passwd" against "/allowed/**".
  if (containsParentRefSegment(input.path)) {
    return {
      ok: false,
      code: "POLICY_DENIED",
      reason: "path contains '..' segments; reject before glob match",
      askable: false,
    };
  }
  const config = readFilePolicyConfig(input.pluginConfig);
  if (!config) {
    return {
      ok: false,
      code: "NO_POLICY",
      reason:
        "no plugins.entries.file-transfer.config.nodes config; file-transfer is deny-by-default until configured",
      askable: false,
    };
  }
  const resolved = resolveNodePolicy(config, input.nodeId, input.nodeDisplayName);
  if (!resolved) {
    return {
      ok: false,
      code: "NO_POLICY",
      reason: `no file-transfer policy entry for "${input.nodeDisplayName ?? input.nodeId}"; configure plugins.entries.file-transfer.config.nodes or "*"`,
      askable: false,
    };
  }
  const nodeConfig = resolved.entry;
  const askMode = normalizeAskMode(nodeConfig.ask);

  const maxBytes =
    typeof nodeConfig.maxBytes === "number" && Number.isFinite(nodeConfig.maxBytes)
      ? Math.max(1, Math.floor(nodeConfig.maxBytes))
      : undefined;
  const followSymlinks = nodeConfig.followSymlinks === true;

  // 1. Deny patterns always win.
  const denyPatterns = normalizeGlobs(nodeConfig.denyPaths);
  if (matchesAny(input.path, denyPatterns)) {
    return {
      ok: false,
      code: "POLICY_DENIED",
      reason: "path matches a denyPaths pattern",
      askable: false,
      askMode,
      maxBytes,
      followSymlinks,
    };
  }

  // 2. ask=always: prompt every time even if matched.
  if (askMode === "always") {
    return { ok: true, reason: "ask-always", askMode, maxBytes, followSymlinks };
  }

  // 3. Match against allow list for this kind.
  const allowPatterns =
    input.kind === "read"
      ? normalizeGlobs(nodeConfig.allowReadPaths)
      : normalizeGlobs(nodeConfig.allowWritePaths);

  if (allowPatterns.length > 0 && matchesAny(input.path, allowPatterns)) {
    return { ok: true, reason: "matched-allow", maxBytes, followSymlinks };
  }

  // 4. No allow match. Either askable on miss or hard-deny.
  if (askMode === "on-miss") {
    return {
      ok: false,
      code: "POLICY_DENIED",
      reason: `path does not match any allow${input.kind === "read" ? "Read" : "Write"}Paths pattern`,
      askable: true,
      askMode,
      maxBytes,
      followSymlinks,
    };
  }

  return {
    ok: false,
    code: "POLICY_DENIED",
    reason:
      allowPatterns.length === 0
        ? `no allow${input.kind === "read" ? "Read" : "Write"}Paths configured`
        : `path does not match any allow${input.kind === "read" ? "Read" : "Write"}Paths pattern`,
    askable: false,
    askMode,
    maxBytes,
    followSymlinks,
  };
}

/**
 * Persist an "allow-always" approval by appending the path to the
 * relevant allowReadPaths / allowWritePaths list for the node. Uses
 * mutateConfigFile so the change survives gateway restarts.
 *
 * Inserts under whichever key matched the policy (per-node entry, or
 * the "*" wildcard if that's what was hit). If no entry exists yet,
 * creates one keyed by nodeDisplayName ?? nodeId.
 */
/**
 * Reject special object keys that would mutate the prototype chain when
 * used as a property name (e.g. `__proto__` setter on a plain object).
 * The nodeDisplayName comes from paired-node metadata which we don't
 * fully control; refuse to persist policy under a key that could corrupt
 * the plugin policy container's prototype.
 */
function assertSafeConfigKey(key: string): string {
  if (key === "__proto__" || key === "prototype" || key === "constructor") {
    throw new Error(`refusing to persist file-transfer policy under unsafe key: ${key}`);
  }
  return key;
}

export async function persistAllowAlways(input: {
  nodeId: string;
  nodeDisplayName?: string;
  kind: FilePolicyKind;
  path: string;
}): Promise<void> {
  const field = input.kind === "read" ? "allowReadPaths" : "allowWritePaths";
  await mutateConfigFile({
    afterWrite: { mode: "none", reason: "file-transfer allow-always policy update" },
    mutate: (draft) => {
      // Plugin config is intentionally plugin-owned; the root OpenClawConfig
      // type only guarantees `Record<string, unknown>` here.
      const root = draft as unknown as Record<string, unknown>;
      const plugins = (root.plugins ??= {}) as Record<string, unknown>;
      const entries = (plugins.entries ??= {}) as Record<string, unknown>;
      const pluginEntry = (entries["file-transfer"] ??= {}) as Record<string, unknown>;
      const pluginConfig = (pluginEntry.config ??= {}) as Record<string, unknown>;
      const fileTransfer = (pluginConfig.nodes ??= {}) as Record<string, NodeFilePolicyConfig>;

      // SECURITY: never persist allow-always under the "*" wildcard. An
      // operator approving a path on node A must not silently grant the
      // same path on every other node sharing the wildcard entry. Always
      // write under the specific node's own entry, creating it if needed.
      const candidates = [input.nodeId, input.nodeDisplayName].filter(
        (k): k is string => typeof k === "string" && k.length > 0,
      );
      // Use hasOwnProperty so a node with displayName "constructor" doesn't
      // accidentally hit Object.prototype.constructor and pretend to match.
      let key = candidates.find((c) => Object.prototype.hasOwnProperty.call(fileTransfer, c));
      if (!key) {
        key = assertSafeConfigKey(input.nodeDisplayName ?? input.nodeId);
        fileTransfer[key] = {};
      }
      const entry = fileTransfer[key];
      const list = Array.isArray(entry[field]) ? entry[field] : [];
      if (!list.includes(input.path)) {
        list.push(input.path);
      }
      entry[field] = list;
    },
  });
}
