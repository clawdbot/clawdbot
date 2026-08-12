// Audits installed plugins for trust, provenance, and filesystem risks.
import path from "node:path";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { inspectReadOnlyChannelAccount } from "../channels/read-only-account-inspect.js";
import { resolveNativeSkillsEnabled } from "../config/commands.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import { readHookInstalls } from "../hooks/installs.js";
import { readInstalledPackageVersion } from "../infra/package-update-utils.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-record-reader.js";
import {
  createPluginRegistryIdNormalizer,
  loadPluginRegistrySnapshot,
} from "../plugins/plugin-registry.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import type { SecurityAuditFinding } from "./audit.types.js";
import { listInstalledPluginDirs } from "./installed-plugin-dirs.js";

type PluginTrustPolicyDeps = {
  buildPluginToolGroups: typeof import("../agents/tool-policy.js").buildPluginToolGroups;
  expandPolicyWithPluginGroups: typeof import("../agents/tool-policy.js").expandPolicyWithPluginGroups;
  resolveConfiguredToolPolicies: typeof import("../agents/agent-tools.policy.js").resolveConfiguredToolPolicies;
  isToolAllowedByPolicies: typeof import("../agents/tool-policy-match.js").isToolAllowedByPolicies;
  resolveSandboxConfigForAgent: typeof import("../agents/sandbox/config.js").resolveSandboxConfigForAgent;
};

/** Lazily load tool-policy helpers so basic security imports avoid agent policy modules. */
const loadPluginTrustPolicyDeps = createLazyPromise<PluginTrustPolicyDeps>(
  () =>
    Promise.all([
      import("../agents/agent-tools.policy.js"),
      import("../agents/sandbox/config.js"),
      import("../agents/tool-policy-match.js"),
      import("../agents/tool-policy.js"),
    ]).then(([agentToolPolicy, sandboxConfig, toolPolicyMatch, toolPolicy]) => ({
      buildPluginToolGroups: toolPolicy.buildPluginToolGroups,
      expandPolicyWithPluginGroups: toolPolicy.expandPolicyWithPluginGroups,
      resolveConfiguredToolPolicies: agentToolPolicy.resolveConfiguredToolPolicies,
      isToolAllowedByPolicies: toolPolicyMatch.isToolAllowedByPolicies,
      resolveSandboxConfigForAgent: sandboxConfig.resolveSandboxConfigForAgent,
    })),
  { cacheRejections: true },
);

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

/** Collect supply-chain and reachable-tool findings for installed plugins and hook packs. */
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
    const pluginIndex = loadPluginRegistrySnapshot({
      config: params.cfg,
      stateDir: params.stateDir,
    });
    const normalizePluginId = createPluginRegistryIdNormalizer(pluginIndex);

    if (allowConfigured) {
      const installedPluginIds = new Set(pluginDirs.map((dir) => path.basename(dir).toLowerCase()));
      // Allowlist entries may use aliases/canonical ids. Normalize against the
      // current registry before treating an entry as phantom.
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
      const enabledPluginIds = new Set(
        enabledExtensionPluginIds.map((pluginId) => normalizePluginId(pluginId).toLowerCase()),
      );
      const declaredPluginTools = pluginIndex.plugins.flatMap((plugin) => {
        const pluginId = normalizePluginId(plugin.pluginId).toLowerCase();
        if (!enabledPluginIds.has(pluginId)) {
          return [];
        }
        return (plugin.contributions?.contracts.tools ?? []).map((name) => ({ name, pluginId }));
      });
      const pluginGroups = deps.buildPluginToolGroups({
        tools: declaredPluginTools,
        toolMeta: (tool) => ({ pluginId: tool.pluginId }),
      });
      const declaredPluginIds = new Set(declaredPluginTools.map((tool) => tool.pluginId));
      const pluginsMissingToolContracts = [...enabledPluginIds].filter(
        (pluginId) => !declaredPluginIds.has(pluginId),
      );
      // Older indexes can lack contracts.tools for only some enabled plugins. Keep
      // conservative probes for those gaps while using concrete names everywhere else.
      const pluginPolicyProbes = [
        ...pluginGroups.all,
        ...(pluginsMissingToolContracts.length > 0
          ? ["__openclaw_plugin_probe__", ...pluginsMissingToolContracts]
          : []),
      ];
      const contexts: Array<{
        label: string;
        agentId?: string;
        tools?: AgentToolsConfig;
      }> = [{ label: "default" }];
      for (const entry of listAgentEntries(params.cfg)) {
        if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
          continue;
        }
        contexts.push({
          label: `agents.entries.${entry.id}`,
          agentId: entry.id,
          tools: entry.tools,
        });
      }

      const permissiveContexts: string[] = [];
      for (const context of contexts) {
        const sandboxMode = deps.resolveSandboxConfigForAgent(params.cfg, context.agentId).mode;
        const policies = deps.resolveConfiguredToolPolicies({
          cfg: params.cfg,
          agentTools: context.tools,
          sandboxMode,
          agentId: context.agentId ?? null,
        });
        const expandedPolicies = policies.map((policy) =>
          deps.expandPolicyWithPluginGroups(policy, pluginGroups),
        );
        // Provider/model policies only intersect these base layers at runtime; they cannot
        // re-add a plugin tool removed here. A permissive base is therefore the audit boundary.
        if (
          pluginPolicyProbes.some((probe) => deps.isToolAllowedByPolicies(probe, expandedPolicies))
        ) {
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
      // Installed package.json is the local truth; registry metadata drift means
      // update/reinstall should refresh the recorded supply-chain evidence.
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

  const hookInstalls = readHookInstalls({
    env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
  });
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
