import { DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS } from "../agents/sandbox/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";
import { collectCoreInsecureOrDangerousFlags } from "./core-dangerous-config-flags.js";

type DangerousFlagValue = string | number | boolean | null;

type DangerousFlagContract = {
  path: string;
  equals: DangerousFlagValue;
};

type PluginConfigContractMetadata = {
  configContracts: {
    dangerousFlags?: DangerousFlagContract[];
  };
};

type PluginConfigContractMatch = {
  path: string;
  value: unknown;
};

type CollectPluginConfigContractMatches = (input: {
  pathPattern: string;
  root: Record<string, unknown>;
}) => Iterable<PluginConfigContractMatch>;

export type DangerousConfigFlagContractInputs = {
  configContractsById?: ReadonlyMap<string, PluginConfigContractMetadata>;
  collectPluginConfigContractMatches?: CollectPluginConfigContractMatches;
};

function formatDangerousConfigFlagValue(value: DangerousFlagValue): string {
  return value === null ? "null" : String(value);
}

function getAgentDangerousFlagPathSegment(agent: unknown, index: number): string {
  const id =
    agent &&
    typeof agent === "object" &&
    !Array.isArray(agent) &&
    typeof (agent as { id?: unknown }).id === "string" &&
    (agent as { id: string }).id.length > 0
      ? (agent as { id: string }).id
      : undefined;
  return id ? `agents.list[id=${JSON.stringify(id)}]` : `agents.list[${index}]`;
}

function collectExactPluginConfigContractMatches({
  pathPattern,
  root,
}: {
  pathPattern: string;
  root: Record<string, unknown>;
}): PluginConfigContractMatch[] {
  return Object.hasOwn(root, pathPattern) ? [{ path: pathPattern, value: root[pathPattern] }] : [];
}

export function collectEnabledInsecureOrDangerousFlagsFromContracts(
  cfg: OpenClawConfig,
  inputs: DangerousConfigFlagContractInputs = {},
): string[] {
  const enabledFlags = collectCoreInsecureOrDangerousFlags(cfg);

  const collectSandboxDockerDangerousFlags = (
    docker: Record<string, unknown> | undefined,
    pathPrefix: string,
  ): void => {
    if (!isRecord(docker)) {
      return;
    }
    for (const key of DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS) {
      if (docker[key] === true) {
        enabledFlags.push(`${pathPrefix}.${key}=true`);
      }
    }
  };

  if (cfg.hooks?.allowRequestSessionKey === true) {
    enabledFlags.push("hooks.allowRequestSessionKey=true");
  }
  if (cfg.browser?.ssrfPolicy?.dangerouslyAllowPrivateNetwork === true) {
    enabledFlags.push("browser.ssrfPolicy.dangerouslyAllowPrivateNetwork=true");
  }
  if (cfg.tools?.fs?.workspaceOnly === false) {
    enabledFlags.push("tools.fs.workspaceOnly=false");
  }
  collectSandboxDockerDangerousFlags(
    isRecord(cfg.agents?.defaults?.sandbox?.docker)
      ? cfg.agents?.defaults?.sandbox?.docker
      : undefined,
    "agents.defaults.sandbox.docker",
  );
  if (Array.isArray(cfg.agents?.list)) {
    for (const [index, agent] of cfg.agents.list.entries()) {
      collectSandboxDockerDangerousFlags(
        isRecord(agent?.sandbox?.docker) ? agent.sandbox.docker : undefined,
        `${getAgentDangerousFlagPathSegment(agent, index)}.sandbox.docker`,
      );
    }
  }

  const pluginEntries = cfg.plugins?.entries;
  if (!isRecord(pluginEntries)) {
    return enabledFlags;
  }

  const configContracts = inputs.configContractsById ?? new Map();
  const collectPluginConfigContractMatches =
    inputs.collectPluginConfigContractMatches ?? collectExactPluginConfigContractMatches;
  const seenFlags = new Set<string>();
  for (const [pluginId, metadata] of configContracts.entries()) {
    const dangerousFlags = metadata.configContracts.dangerousFlags;
    if (!dangerousFlags?.length) {
      continue;
    }
    const pluginEntry = pluginEntries[pluginId];
    if (!isRecord(pluginEntry) || !isRecord(pluginEntry.config)) {
      continue;
    }
    for (const flag of dangerousFlags) {
      for (const match of collectPluginConfigContractMatches({
        root: pluginEntry.config,
        pathPattern: flag.path,
      })) {
        if (!Object.is(match.value, flag.equals)) {
          continue;
        }
        const rendered =
          `plugins.entries.${pluginId}.config.${match.path}` +
          `=${formatDangerousConfigFlagValue(flag.equals)}`;
        if (seenFlags.has(rendered)) {
          continue;
        }
        seenFlags.add(rendered);
        enabledFlags.push(rendered);
      }
    }
  }

  return enabledFlags;
}
