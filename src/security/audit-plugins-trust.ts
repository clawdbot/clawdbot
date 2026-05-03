import fs from "node:fs/promises";
import path from "node:path";
import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { inspectReadOnlyChannelAccount } from "../channels/read-only-account-inspect.js";
import { resolveNativeSkillsEnabled } from "../config/commands.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import { readInstalledPackageVersion } from "../infra/package-update-utils.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-record-reader.js";
import {
  createPluginRegistryIdNormalizer,
  loadPluginRegistrySnapshot,
} from "../plugins/plugin-registry.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import type { SecurityAuditFinding } from "./audit.types.js";
import { shouldIgnoreInstalledPluginDirName } from "./installed-plugin-dirs.js";

type SandboxToolPolicy = import("../agents/sandbox/types.js").SandboxToolPolicy;

type PluginTrustPolicyDeps = {
  isToolAllowedByPolicies: typeof import("../agents/tool-policy-match.js").isToolAllowedByPolicies;
  pickSandboxToolPolicy: typeof import("./audit-tool-policy.js").pickSandboxToolPolicy;
  resolveSandboxConfigForAgent: typeof import("../agents/sandbox/config.js").resolveSandboxConfigForAgent;
  resolveSandboxToolPolicyForAgent: typeof import("../agents/sandbox/tool-policy.js").resolveSandboxToolPolicyForAgent;
  resolveToolProfilePolicy: typeof import("../agents/tool-policy.js").resolveToolProfilePolicy;
};

let pluginTrustPolicyDepsPromise: Promise<PluginTrustPolicyDeps> | undefined;

async function loadPluginTrustPolicyDeps(): Promise<PluginTrustPolicyDeps> {
  pluginTrustPolicyDepsPromise ??= Promise.all([
    import("../agents/sandbox/config.js"),
    import("../agents/sandbox/tool-policy.js"),
    import("../agents/tool-policy-match.js"),
    import("../agents/tool-policy.js"),
    import("./audit-tool-policy.js"),
  ]).then(([sandboxConfig, sandboxToolPolicy, toolPolicyMatch, toolPolicy, auditToolPolicy]) => ({
    isToolAllowedByPolicies: toolPolicyMatch.isToolAllowedByPolicies,
    pickSandboxToolPolicy: auditToolPolicy.pickSandboxToolPolicy,
    resolveSandboxConfigForAgent: sandboxConfig.resolveSandboxConfigForAgent,
    resolveSandboxToolPolicyForAgent: sandboxToolPolicy.resolveSandboxToolPolicyForAgent,
    resolveToolProfilePolicy: toolPolicy.resolveToolProfilePolicy,
  }));
  return await pluginTrustPolicyDepsPromise;
}

function readChannelCommandSetting(
  cfg: OpenClawConfig,
  channelId: string,
  key: "native" | "nativeSkills",
): unknown {
  const channelCfg = cfg.channels?.[channelId as keyof NonNullable<OpenClawConfig["channels"]>];
  if (!channelCfg || typeof channelCfg !== "object" || Array.isArray(channelCfg)) {
    return undefined;
  }
  const commands = (channelCfg as { commands?: unknown }).commands;
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) {
    return undefined;
  }
  return (commands as Record<string, unknown>)[key];
}

async function isChannelPluginConfigured(
  cfg: OpenClawConfig,
  plugin: ChannelPlugin,
): Promise<boolean> {
  const accountIds = plugin.config.listAccountIds(cfg);
  const candidates = accountIds.length > 0 ? accountIds : [undefined];
  for (const accountId of candidates) {
    const inspected =
      plugin.config.inspectAccount?.(cfg, accountId) ??
      (await inspectReadOnlyChannelAccount({
        channelId: plugin.id,
        cfg,
        accountId,
      }));
    const inspectedRecord =
      inspected && typeof inspected === "object" && !Array.isArray(inspected)
        ? (inspected as Record<string, unknown>)
        : null;
    let resolvedAccount: unknown = inspected;
    if (!resolvedAccount) {
      try {
        resolvedAccount = plugin.config.resolveAccount(cfg, accountId);
      } catch {
        resolvedAccount = null;
      }
    }
    let enabled =
      typeof inspectedRecord?.enabled === "boolean"
        ? inspectedRecord.enabled
        : resolvedAccount != null;
    if (
      typeof inspectedRecord?.enabled !== "boolean" &&
      resolvedAccount != null &&
      plugin.config.isEnabled
    ) {
      try {
        enabled = plugin.config.isEnabled(resolvedAccount, cfg);
      } catch {
        enabled = false;
      }
    }
    let configured =
      typeof inspectedRecord?.configured === "boolean"
        ? inspectedRecord.configured
        : resolvedAccount != null;
    if (
      typeof inspectedRecord?.configured !== "boolean" &&
      resolvedAccount != null &&
      plugin.config.isConfigured
    ) {
      try {
        configured = await plugin.config.isConfigured(resolvedAccount, cfg);
      } catch {
        configured = false;
      }
    }
    if (enabled && configured) {
      return true;
    }
  }
  return false;
}

async function listInstalledPluginDirs(params: {
  stateDir: string;
  onReadError?: (error: unknown) => void;
}): Promise<{ extensionsDir: string; pluginDirs: string[] }> {
  const extensionsDir = path.join(params.stateDir, "extensions");
  const st = await fs.stat(extensionsDir).catch((err: unknown) => {
    params.onReadError?.(err);
    return null;
  });
  if (!st?.isDirectory()) {
    return { extensionsDir, pluginDirs: [] };
  }
  const entries = await fs.readdir(extensionsDir, { withFileTypes: true }).catch((err) => {
    params.onReadError?.(err);
    return [];
  });
  const pluginDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !shouldIgnoreInstalledPluginDirName(name))
    .filter(Boolean);
  return { extensionsDir, pluginDirs };
}

function resolveToolPolicies(params: {
  cfg: OpenClawConfig;
  deps: PluginTrustPolicyDeps;
  agentTools?: AgentToolsConfig;
  sandboxMode?: "off" | "non-main" | "all";
  agentId?: string | null;
}): Array<SandboxToolPolicy | undefined> {
  const profile = params.agentTools?.profile ?? params.cfg.tools?.profile;
  const profilePolicy = params.deps.resolveToolProfilePolicy(profile);
  const policies: Array<SandboxToolPolicy | undefined> = [
    profilePolicy,
    params.deps.pickSandboxToolPolicy(params.cfg.tools ?? undefined),
    params.deps.pickSandboxToolPolicy(params.agentTools),
  ];
  if (params.sandboxMode === "all") {
    policies.push(
      params.deps.resolveSandboxToolPolicyForAgent(params.cfg, params.agentId ?? undefined),
    );
  }
  return policies;
}

function normalizePluginIdSet(entries: string[]): Set<string> {
  return new Set(
    entries
      .map((entry) => normalizeOptionalLowercaseString(entry))
      .filter((entry): entry is string => Boolean(entry)),
  );
}

function resolveEnabledExtensionPluginIds(params: {
  cfg: OpenClawConfig;
  pluginDirs: string[];
}): string[] {
  const normalized = normalizePluginsConfig(params.cfg.plugins);
  if (!normalized.enabled) {
    return [];
  }

  const allowSet = normalizePluginIdSet(normalized.allow);
  const denySet = normalizePluginIdSet(normalized.deny);
  const entryById = new Map<string, { enabled?: boolean }>();
  for (const [id, entry] of Object.entries(normalized.entries)) {
    const normalizedId = normalizeOptionalLowercaseString(id);
    if (!normalizedId) {
      continue;
    }
    entryById.set(normalizedId, entry);
  }

  const enabled: string[] = [];
  for (const id of params.pluginDirs) {
    const normalizedId = normalizeOptionalLowercaseString(id);
    if (!normalizedId) {
      continue;
    }
    if (denySet.has(normalizedId)) {
      continue;
    }
    if (allowSet.size > 0 && !allowSet.has(normalizedId)) {
      continue;
    }
    if (entryById.get(normalizedId)?.enabled === false) {
      continue;
    }
    enabled.push(normalizedId);
  }
  return enabled;
}

function collectAllowEntries(config?: { allow?: string[]; alsoAllow?: string[] }): string[] {
  const out: string[] = [];
  if (Array.isArray(config?.allow)) {
    out.push(...config.allow);
  }
  if (Array.isArray(config?.alsoAllow)) {
    out.push(...config.alsoAllow);
  }
  return out
    .map((entry) => normalizeOptionalLowercaseString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function hasExplicitPluginAllow(params: {
  allowEntries: string[];
  enabledPluginIds: Set<string>;
}): boolean {
  return params.allowEntries.some(
    (entry) => entry === "group:plugins" || params.enabledPluginIds.has(entry),
  );
}

function hasProviderPluginAllow(params: {
  byProvider?: Record<string, { allow?: string[]; alsoAllow?: string[]; deny?: string[] }>;
  enabledPluginIds: Set<string>;
}): boolean {
  if (!params.byProvider) {
    return false;
  }
  for (const policy of Object.values(params.byProvider)) {
    if (
      hasExplicitPluginAllow({
        allowEntries: collectAllowEntries(policy),
        enabledPluginIds: params.enabledPluginIds,
      })
    ) {
      return true;
    }
  }
  return false;
}

function isPinnedRegistrySpec(spec: string): boolean {
  const value = spec.trim();
  if (!value) {
    return false;
  }
  const at = value.lastIndexOf("@");
  if (at <= 0 || at >= value.length - 1) {
    return false;
  }
  const version = value.slice(at + 1).trim();
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

export async function collectPluginsTrustFindings(params: {
  cfg: OpenClawConfig;
  stateDir: string;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const { extensionsDir, pluginDirs } = await listInstalledPluginDirs({
    stateDir: params.stateDir,
  });
  if (pluginDirs.length > 0) {
    const allow = params.cfg.plugins?.allow;
    const allowConfigured = Array.isArray(allow) && allow.length > 0;

    if (allowConfigured) {
      const installedPluginIds = new Set(pluginDirs.map((dir) => path.basename(dir).toLowerCase()));
      const pluginIndex = loadPluginRegistrySnapshot({
        config: params.cfg,
        stateDir: params.stateDir,
      });
      const normalizePluginId = createPluginRegistryIdNormalizer(pluginIndex);
      const indexedPluginIds = new Set(
        pluginIndex.plugins.map((plugin) => plugin.pluginId.toLowerCase()),
      );
      const phantomEntries = allow.filter((entry) => {
        if (typeof entry !== "string" || entry === "group:plugins") {
          return false;
        }
        const lower = entry.toLowerCase();
        if (installedPluginIds.has(lower) || indexedPluginIds.has(lower)) {
          return false;
        }
        const canonicalId = normalizeOptionalLowercaseString(normalizePluginId(entry)) ?? "";
        return !canonicalId || !indexedPluginIds.has(canonicalId);
      });
      if (phantomEntries.length > 0) {
        findings.push({
          checkId: "plugins.allow_phantom_entries",
          severity: "warn",
          title: "plugins.allow contains entries with no matching installed plugin",
          detail:
            `The following plugins.allow entries do not correspond to any installed plugin: ${phantomEntries.join(", ")}.\n` +
            "Phantom entries could be exploited by registering a new plugin with an allowlisted ID.",
          remediation:
            "Remove unused entries from plugins.allow, or verify the expected plugins are installed.",
        });
      }
    }

    if (!allowConfigured) {
      const channelPlugins = listReadOnlyChannelPluginsForConfig(params.cfg, {
        stateDir: params.stateDir,
      });
      const skillCommandsLikelyExposed = (
        await Promise.all(
          channelPlugins.map(async (plugin) => {
            if (
              plugin.capabilities.nativeCommands !== true &&
              plugin.commands?.nativeSkillsAutoEnabled !== true
            ) {
              return false;
            }
            if (!(await isChannelPluginConfigured(params.cfg, plugin))) {
              return false;
            }
            return resolveNativeSkillsEnabled({
              providerId: plugin.id,
              providerSetting: readChannelCommandSetting(params.cfg, plugin.id, "nativeSkills") as
                | "auto"
                | boolean
                | undefined,
              globalSetting: params.cfg.commands?.nativeSkills,
              stateDir: params.stateDir,
              autoDefault: plugin.commands?.nativeSkillsAutoEnabled === true,
            });
          }),
        )
      ).some(Boolean);

      findings.push({
        checkId: "plugins.extensions_no_allowlist",
        severity: skillCommandsLikelyExposed ? "critical" : "warn",
        title: "Extensions exist but plugins.allow is not set",
        detail:
          `Found ${pluginDirs.length} extension(s) under ${extensionsDir}. Without plugins.allow, any discovered plugin id may load (depending on config and plugin behavior).` +
          (skillCommandsLikelyExposed
            ? "\nNative skill commands are enabled on at least one configured chat surface; treat unpinned/unallowlisted extensions as high risk."
            : ""),
        remediation: "Set plugins.allow to an explicit list of plugin ids you trust.",
      });
    }

    const enabledExtensionPluginIds = resolveEnabledExtensionPluginIds({
      cfg: params.cfg,
      pluginDirs,
    });
    if (enabledExtensionPluginIds.length > 0) {
      const deps = await loadPluginTrustPolicyDeps();
      const enabledPluginSet = new Set(enabledExtensionPluginIds);
      const contexts: Array<{
        label: string;
        agentId?: string;
        tools?: AgentToolsConfig;
      }> = [{ label: "default" }];
      for (const entry of params.cfg.agents?.list ?? []) {
        if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
          continue;
        }
        contexts.push({
          label: `agents.list.${entry.id}`,
          agentId: entry.id,
          tools: entry.tools,
        });
      }

      const permissiveContexts: string[] = [];
      for (const context of contexts) {
        const profile = context.tools?.profile ?? params.cfg.tools?.profile;
        const restrictiveProfile = Boolean(deps.resolveToolProfilePolicy(profile));
        const sandboxMode = deps.resolveSandboxConfigForAgent(params.cfg, context.agentId).mode;
        const policies = resolveToolPolicies({
          cfg: params.cfg,
          deps,
          agentTools: context.tools,
          sandboxMode,
          agentId: context.agentId,
        });
        const broadPolicy = deps.isToolAllowedByPolicies("__openclaw_plugin_probe__", policies);
        const explicitPluginAllow =
          !restrictiveProfile &&
          (hasExplicitPluginAllow({
            allowEntries: collectAllowEntries(params.cfg.tools),
            enabledPluginIds: enabledPluginSet,
          }) ||
            hasProviderPluginAllow({
              byProvider: params.cfg.tools?.byProvider,
              enabledPluginIds: enabledPluginSet,
            }) ||
            hasExplicitPluginAllow({
              allowEntries: collectAllowEntries(context.tools),
              enabledPluginIds: enabledPluginSet,
            }) ||
            hasProviderPluginAllow({
              byProvider: context.tools?.byProvider,
              enabledPluginIds: enabledPluginSet,
            }));

        if (broadPolicy || explicitPluginAllow) {
          permissiveContexts.push(context.label);
        }
      }

      if (permissiveContexts.length > 0) {
        findings.push({
          checkId: "plugins.tools_reachable_permissive_policy",
          severity: "warn",
          title: "Extension plugin tools may be reachable under permissive tool policy",
          detail:
            `Enabled extension plugins: ${enabledExtensionPluginIds.join(", ")}.\n` +
            `Permissive tool policy contexts:\n${permissiveContexts.map((entry) => `- ${entry}`).join("\n")}`,
          remediation:
            "Use restrictive profiles (`minimal`/`coding`) or explicit tool allowlists that exclude plugin tools for agents handling untrusted input.",
        });
      }
    }
  }

  const pluginInstalls = await loadInstalledPluginIndexInstallRecords({
    stateDir: params.stateDir,
  });
  const npmPluginInstalls = Object.entries(pluginInstalls).filter(
    ([, record]) => record?.source === "npm",
  );
  if (npmPluginInstalls.length > 0) {
    const unpinned = npmPluginInstalls
      .filter(([, record]) => typeof record.spec === "string" && !isPinnedRegistrySpec(record.spec))
      .map(([pluginId, record]) => `${pluginId} (${record.spec})`);
    if (unpinned.length > 0) {
      findings.push({
        checkId: "plugins.installs_unpinned_npm_specs",
        severity: "warn",
        title: "Plugin index includes unpinned npm specs",
        detail: `Unpinned plugin index install records:\n${unpinned.map((entry) => `- ${entry}`).join("\n")}`,
        remediation:
          "Pin install specs to exact versions (for example, `@scope/pkg@1.2.3`) for higher supply-chain stability.",
      });
    }

    const missingIntegrity = npmPluginInstalls
      .filter(
        ([, record]) => typeof record.integrity !== "string" || record.integrity.trim() === "",
      )
      .map(([pluginId]) => pluginId);
    if (missingIntegrity.length > 0) {
      findings.push({
        checkId: "plugins.installs_missing_integrity",
        severity: "warn",
        title: "Plugin index is missing integrity metadata",
        detail: `Plugin index records missing integrity:\n${missingIntegrity.map((entry) => `- ${entry}`).join("\n")}`,
        remediation:
          "Reinstall or update plugins to refresh install metadata with resolved integrity hashes.",
      });
    }

    const pluginVersionDrift: string[] = [];
    for (const [pluginId, record] of npmPluginInstalls) {
      const recordedVersion = record.resolvedVersion ?? record.version;
      if (!recordedVersion) {
        continue;
      }
      const installPath = record.installPath ?? path.join(params.stateDir, "extensions", pluginId);
      const installedVersion = await readInstalledPackageVersion(installPath);
      if (!installedVersion || installedVersion === recordedVersion) {
        continue;
      }
      pluginVersionDrift.push(
        `${pluginId} (recorded ${recordedVersion}, installed ${installedVersion})`,
      );
    }
    if (pluginVersionDrift.length > 0) {
      findings.push({
        checkId: "plugins.installs_version_drift",
        severity: "warn",
        title: "Plugin index records drift from installed package versions",
        detail: `Detected plugin install metadata drift:\n${pluginVersionDrift.map((entry) => `- ${entry}`).join("\n")}`,
        remediation:
          "Run `openclaw plugins update --all` (or reinstall affected plugins) to refresh install metadata.",
      });
    }
  }

  const hookInstalls = params.cfg.hooks?.internal?.installs ?? {};
  const npmHookInstalls = Object.entries(hookInstalls).filter(
    ([, record]) => record?.source === "npm",
  );
  if (npmHookInstalls.length > 0) {
    const unpinned = npmHookInstalls
      .filter(([, record]) => typeof record.spec === "string" && !isPinnedRegistrySpec(record.spec))
      .map(([hookId, record]) => `${hookId} (${record.spec})`);
    if (unpinned.length > 0) {
      findings.push({
        checkId: "hooks.installs_unpinned_npm_specs",
        severity: "warn",
        title: "Hook installs include unpinned npm specs",
        detail: `Unpinned hook install records:\n${unpinned.map((entry) => `- ${entry}`).join("\n")}`,
        remediation:
          "Pin hook install specs to exact versions (for example, `@scope/pkg@1.2.3`) for higher supply-chain stability.",
      });
    }

    const missingIntegrity = npmHookInstalls
      .filter(
        ([, record]) => typeof record.integrity !== "string" || record.integrity.trim() === "",
      )
      .map(([hookId]) => hookId);
    if (missingIntegrity.length > 0) {
      findings.push({
        checkId: "hooks.installs_missing_integrity",
        severity: "warn",
        title: "Hook installs are missing integrity metadata",
        detail: `Hook install records missing integrity:\n${missingIntegrity.map((entry) => `- ${entry}`).join("\n")}`,
        remediation:
          "Reinstall or update hooks to refresh install metadata with resolved integrity hashes.",
      });
    }

    const hookVersionDrift: string[] = [];
    for (const [hookId, record] of npmHookInstalls) {
      const recordedVersion = record.resolvedVersion ?? record.version;
      if (!recordedVersion) {
        continue;
      }
      const installPath = record.installPath ?? path.join(params.stateDir, "hooks", hookId);
      const installedVersion = await readInstalledPackageVersion(installPath);
      if (!installedVersion || installedVersion === recordedVersion) {
        continue;
      }
      hookVersionDrift.push(
        `${hookId} (recorded ${recordedVersion}, installed ${installedVersion})`,
      );
    }
    if (hookVersionDrift.length > 0) {
      findings.push({
        checkId: "hooks.installs_version_drift",
        severity: "warn",
        title: "Hook install records drift from installed package versions",
        detail: `Detected hook install metadata drift:\n${hookVersionDrift.map((entry) => `- ${entry}`).join("\n")}`,
        remediation:
          "Run `openclaw hooks update --all` (or reinstall affected hooks) to refresh install metadata.",
      });
    }
  }

  return findings;
}
