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
// `allow-always` grants are stored separately from operator-authored globs.
// They are scoped to a stable node ID, command, requested path, and the
// node-authoritative canonical path returned by the successful operation.
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
import {
  asNullableRecord,
  asOptionalObjectRecord,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  FILE_TRANSFER_NODE_INVOKE_COMMANDS,
  type FileTransferNodeInvokeCommand,
} from "./node-invoke-policy-commands.js";

export type FilePolicyKind = "read" | "write";
type FilePolicyAskMode = "off" | "on-miss" | "always";
export const FILE_TRANSFER_POLICY_VERSION = 2;

export type FileTransferLiteralGrant = {
  nodeId: string;
  command: FileTransferNodeInvokeCommand;
  requestedPath: string;
  canonicalPath: string;
};

type FilePolicyDecision =
  | {
      ok: true;
      reason: "matched-allow" | "matched-literal";
      maxBytes?: number;
      followSymlinks: boolean;
      expectedCanonicalPath?: string;
    }
  | {
      ok: true;
      reason: "ask-always";
      askMode: FilePolicyAskMode;
      maxBytes?: number;
      followSymlinks: boolean;
    }
  | {
      ok: false;
      code: "NO_POLICY" | "POLICY_DENIED" | "POLICY_MIGRATION_REQUIRED";
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

type FileTransferPolicyConfig = {
  policyVersion?: number;
  nodes?: FilePolicyConfig;
  literalGrants?: unknown;
};

function asFilePolicyConfig(value: unknown): FilePolicyConfig | null {
  return asNullableRecord(value) as FilePolicyConfig | null;
}

function readFileTransferConfigFromPluginConfig(
  pluginConfig: unknown,
): FileTransferPolicyConfig | null {
  const pluginRecord = asNullableRecord(pluginConfig);
  if (!pluginRecord) {
    return null;
  }
  return {
    policyVersion:
      typeof pluginRecord.policyVersion === "number" ? pluginRecord.policyVersion : undefined,
    nodes: asFilePolicyConfig(pluginRecord.nodes) ?? undefined,
    literalGrants: pluginRecord.literalGrants,
  };
}

function readPluginConfigFromRuntimeConfig(): Record<string, unknown> | null {
  const cfg = getRuntimeConfig();
  const plugins = asOptionalObjectRecord((cfg as { plugins?: unknown }).plugins);
  if (!plugins) {
    return null;
  }
  const entries = asOptionalObjectRecord(plugins.entries);
  if (!entries) {
    return null;
  }
  const entry = asOptionalObjectRecord(entries["file-transfer"]);
  if (!entry) {
    return null;
  }
  return asNullableRecord(entry.config);
}

function readFileTransferConfig(
  pluginConfig?: Record<string, unknown>,
): FileTransferPolicyConfig | null {
  return (
    readFileTransferConfigFromPluginConfig(readPluginConfigFromRuntimeConfig()) ??
    readFileTransferConfigFromPluginConfig(pluginConfig)
  );
}

function readNodes(config: FileTransferPolicyConfig): FilePolicyConfig | null {
  return asFilePolicyConfig(config.nodes);
}

function hasLegacyPositiveRules(config: FileTransferPolicyConfig): boolean {
  const nodes = readNodes(config);
  if (!nodes) {
    return false;
  }
  return Object.values(nodes).some(
    (entry) =>
      (Array.isArray(entry.allowReadPaths) && entry.allowReadPaths.length > 0) ||
      (Array.isArray(entry.allowWritePaths) && entry.allowWritePaths.length > 0),
  );
}

function readLiteralGrants(config: FileTransferPolicyConfig): FileTransferLiteralGrant[] {
  if (
    config.policyVersion !== FILE_TRANSFER_POLICY_VERSION ||
    !Array.isArray(config.literalGrants)
  ) {
    return [];
  }
  return config.literalGrants.flatMap((value) => {
    const grant = asNullableRecord(value);
    if (
      !grant ||
      typeof grant.nodeId !== "string" ||
      !isFileTransferCommand(grant.command) ||
      typeof grant.requestedPath !== "string" ||
      typeof grant.canonicalPath !== "string"
    ) {
      return [];
    }
    return [
      {
        nodeId: grant.nodeId,
        command: grant.command,
        requestedPath: grant.requestedPath,
        canonicalPath: grant.canonicalPath,
      },
    ];
  });
}

function isFileTransferCommand(value: unknown): value is FileTransferNodeInvokeCommand {
  return (
    typeof value === "string" &&
    FILE_TRANSFER_NODE_INVOKE_COMMANDS.some((command) => command === value)
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

function matchesAnyDeny(target: string, patterns: string[]): boolean {
  if (matchesAny(target, patterns)) {
    return true;
  }
  return matchesAny(`${target.replace(/[\\/]+$/u, "")}/`, patterns);
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

type FilePolicyInput = {
  nodeId: string;
  nodeDisplayName?: string;
  kind: FilePolicyKind;
  command?: FileTransferNodeInvokeCommand;
  path: string;
  pluginConfig?: Record<string, unknown>;
};

function evaluateFilePolicyInternal(
  input: FilePolicyInput,
  constraintsOnly: boolean,
): FilePolicyDecision {
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
  const pluginPolicy = readFileTransferConfig(input.pluginConfig);
  const config = pluginPolicy ? readNodes(pluginPolicy) : null;
  if (!pluginPolicy || !config) {
    return {
      ok: false,
      code: "NO_POLICY",
      reason:
        "no plugins.entries.file-transfer.config.nodes config; file-transfer is deny-by-default until configured",
      askable: false,
    };
  }
  if (
    pluginPolicy.policyVersion !== FILE_TRANSFER_POLICY_VERSION &&
    hasLegacyPositiveRules(pluginPolicy)
  ) {
    return {
      ok: false,
      code: "POLICY_MIGRATION_REQUIRED",
      reason:
        "older file-transfer permissions need review; run `openclaw file-transfer approvals migrate`",
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
  if (matchesAnyDeny(input.path, denyPatterns)) {
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

  if (constraintsOnly) {
    return { ok: true, reason: "matched-allow", maxBytes, followSymlinks };
  }

  // 2. ask=always: prompt every time even if matched.
  if (askMode === "always") {
    return { ok: true, reason: "ask-always", askMode, maxBytes, followSymlinks };
  }

  // 3. Match operator-authored glob policy for this kind.
  const allowPatterns =
    input.kind === "read"
      ? normalizeGlobs(nodeConfig.allowReadPaths)
      : normalizeGlobs(nodeConfig.allowWritePaths);

  if (allowPatterns.length > 0 && matchesAny(input.path, allowPatterns)) {
    return { ok: true, reason: "matched-allow", maxBytes, followSymlinks };
  }

  // 4. Match exact standing grants by stable identity and command. These
  // strings are opaque node paths: never normalize them or feed them to a
  // glob matcher on the Gateway.
  if (input.command) {
    const literal = readLiteralGrants(pluginPolicy).find(
      (grant) =>
        grant.nodeId === input.nodeId &&
        grant.command === input.command &&
        grant.requestedPath === input.path,
    );
    if (literal) {
      return {
        ok: true,
        reason: "matched-literal",
        expectedCanonicalPath: literal.canonicalPath,
        maxBytes,
        followSymlinks,
      };
    }
  }

  // 5. No allow match. Either askable on miss or hard-deny.
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

export function evaluateFilePolicy(input: FilePolicyInput): FilePolicyDecision {
  return evaluateFilePolicyInternal(input, false);
}

export function evaluateFilePolicyConstraints(input: FilePolicyInput): FilePolicyDecision {
  return evaluateFilePolicyInternal(input, true);
}

/** Persist an exact standing grant only after node canonical-path validation. */
export async function persistLiteralGrant(input: FileTransferLiteralGrant): Promise<void> {
  if (!isFileTransferCommand(input.command)) {
    throw new Error("unsupported file-transfer command");
  }
  if (!input.nodeId || !input.requestedPath || !input.canonicalPath) {
    throw new Error("file-transfer literal grant requires node, requested, and canonical paths");
  }
  await mutateConfigFile({
    afterWrite: { mode: "none", reason: "file-transfer literal approval update" },
    mutate: (draft) => {
      const plugins = (draft.plugins ??= {}) as Record<string, unknown>;
      const entries = (plugins.entries ??= {}) as Record<string, unknown>;
      const pluginEntry = (entries["file-transfer"] ??= {}) as Record<string, unknown>;
      const pluginConfig = (pluginEntry.config ??= {}) as Record<string, unknown>;
      const policyConfig = pluginConfig as FileTransferPolicyConfig;
      if (
        policyConfig.policyVersion !== FILE_TRANSFER_POLICY_VERSION &&
        hasLegacyPositiveRules(policyConfig)
      ) {
        throw new Error(
          "older file-transfer permissions need review; run `openclaw file-transfer approvals migrate`",
        );
      }
      policyConfig.policyVersion = FILE_TRANSFER_POLICY_VERSION;
      const grants = readLiteralGrants(policyConfig).filter(
        (grant) =>
          grant.nodeId !== input.nodeId ||
          grant.command !== input.command ||
          grant.requestedPath !== input.requestedPath,
      );
      grants.push({ ...input });
      policyConfig.literalGrants = grants;
    },
  });
}
