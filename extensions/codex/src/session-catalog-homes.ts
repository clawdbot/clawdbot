import fs from "node:fs";
import path from "node:path";
import { listAgentIds, resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerLocalHomeDir,
} from "./app-server/auth-start-options.js";
import {
  readCodexPluginConfig,
  resolveCodexAppServerUserHomeDir,
  resolveCodexSupervisionAppServerRuntimeOptions,
} from "./app-server/config.js";
import {
  buildCodexAppServerConnectionFingerprint,
  replaceCodexCatalogConnectionHomes,
} from "./app-server/plugin-app-cache-key.js";
import { canonicalCodexCatalogHome, codexCatalogHomeId } from "./session-catalog-home-id.js";
import { CODEX_LOCAL_SESSION_HOST_ID, MAX_HOST_COUNT } from "./session-catalog-parsing.js";
import type { CodexCatalogHome } from "./session-catalog-types.js";

export type { CodexCatalogHome } from "./session-catalog-types.js";

type CatalogHomeCandidate = {
  codexHome: string;
  label: string;
  usesProcessHomeFallback?: boolean;
};

function existingCatalogHomeCandidates(value: string, label?: string): CatalogHomeCandidate[] {
  const codexHome = canonicalCodexCatalogHome(value);
  try {
    if (!fs.statSync(codexHome).isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }
  return [{ codexHome, label: `Local Codex · ${label ?? path.basename(codexHome)}` }];
}

/** Resolves every local Codex store the operator already owns, without path disclosure. */
function resolveCodexCatalogHomes(params: {
  config: OpenClawConfig;
  pluginConfig: unknown;
  ownerAgentId: string;
  env: NodeJS.ProcessEnv;
}): CodexCatalogHome[] {
  const { config, env, ownerAgentId, pluginConfig } = params;
  const ownerAgentDir = resolveAgentDir(config, ownerAgentId, env);
  const configuredHomes = readCodexPluginConfig(pluginConfig).sessionCatalog?.homes ?? [];
  const base = resolveCodexSupervisionAppServerRuntimeOptions({
    pluginConfig,
    env,
    agentDir: ownerAgentDir,
    config,
  });
  const primaryCodexHome = canonicalCodexCatalogHome(
    resolveCodexAppServerLocalHomeDir(base.start, ownerAgentDir, env),
  );
  const processUserHome = canonicalCodexCatalogHome(resolveCodexAppServerUserHomeDir(env));
  const processHomeConfigured = Boolean(env.CODEX_HOME?.trim());
  const primaryUsesProcessHomeFallback =
    base.start.transport === "stdio" && base.start.homeScope === "user" && !processHomeConfigured;
  const candidates: CatalogHomeCandidate[] = [
    {
      codexHome: primaryCodexHome,
      label: "Local Codex",
      usesProcessHomeFallback: primaryUsesProcessHomeFallback,
    },
  ];

  if (base.start.transport === "stdio") {
    candidates.push({
      codexHome: processUserHome,
      label: "Local Codex · user",
      usesProcessHomeFallback: !processHomeConfigured,
    });
    const agentIds = listAgentIds(config).toSorted((left, right) =>
      left === ownerAgentId ? -1 : right === ownerAgentId ? 1 : left.localeCompare(right),
    );
    candidates.push(
      ...agentIds.flatMap((agentId) =>
        existingCatalogHomeCandidates(
          resolveCodexAppServerHomeDir(resolveAgentDir(config, agentId, env)),
          agentId,
        ),
      ),
      ...configuredHomes.flatMap((entry) => {
        const { path: home, label } = typeof entry === "string" ? { path: entry } : entry;
        return existingCatalogHomeCandidates(home, label);
      }),
    );
  }

  const seen = new Set<string>();
  const homes: CodexCatalogHome[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.codexHome)) {
      continue;
    }
    seen.add(candidate.codexHome);
    const sourceHomeId = codexCatalogHomeId(candidate.codexHome);
    const primary = homes.length === 0;
    homes.push({
      sourceHomeId,
      hostId: primary
        ? CODEX_LOCAL_SESSION_HOST_ID
        : `${CODEX_LOCAL_SESSION_HOST_ID}:${sourceHomeId}`,
      label: candidate.label,
      agentDir: ownerAgentDir,
      appServer: primary
        ? base
        : {
            ...base,
            start: {
              ...base.start,
              homeScope: "user",
              env: { ...base.start.env, CODEX_HOME: candidate.codexHome },
            },
          },
      ...(base.connectionClass === "remote"
        ? {}
        : { localSessionsRoot: path.join(candidate.codexHome, "sessions") }),
      usesProcessHomeFallback: candidate.usesProcessHomeFallback ?? false,
    });
    if (homes.length >= MAX_HOST_COUNT) {
      break;
    }
  }
  return homes;
}

type CodexCatalogHomeResolver = {
  forAgent(agentId: string): readonly CodexCatalogHome[];
};

/** Discovers Codex homes once per immutable Gateway config generation. */
export function createCodexCatalogHomeResolver(params: {
  config: OpenClawConfig;
  getRuntimeConfig: () => OpenClawConfig | undefined;
  getPluginConfig: () => unknown;
  env?: NodeJS.ProcessEnv;
}): CodexCatalogHomeResolver {
  const env = params.env ?? process.env;
  const homesByConfig = new WeakMap<OpenClawConfig, Map<string, readonly CodexCatalogHome[]>>();
  const buildSnapshot = (config: OpenClawConfig) => {
    const pluginConfig = params.getPluginConfig();
    const homesByAgent = new Map(
      listAgentIds(config).map((agentId) => [
        agentId,
        resolveCodexCatalogHomes({
          config,
          pluginConfig,
          ownerAgentId: agentId,
          env,
        }),
      ]),
    );
    replaceCodexCatalogConnectionHomes(
      [...homesByAgent.values()].flatMap((homes) =>
        homes
          .filter((home) => home.appServer.start.transport === "stdio")
          .map((home) => ({
            agentDir: home.agentDir,
            fingerprint: buildCodexAppServerConnectionFingerprint(home.appServer, home.agentDir),
            codexHome: resolveCodexAppServerLocalHomeDir(home.appServer.start, home.agentDir, env),
          })),
      ),
    );
    homesByConfig.set(config, homesByAgent);
    return homesByAgent;
  };
  let lastSnapshot = buildSnapshot(params.config);
  return {
    forAgent(agentId) {
      // agents.entries hot-reloads without plugin re-registration. Config identity therefore owns
      // both filesystem discovery and the supervised-binding connection-home snapshot.
      const config = params.getRuntimeConfig();
      if (!config) {
        return lastSnapshot.get(agentId) ?? [];
      }
      const cached = homesByConfig.get(config);
      if (cached) {
        return cached.get(agentId) ?? [];
      }
      lastSnapshot = buildSnapshot(config);
      return lastSnapshot.get(agentId) ?? [];
    },
  };
}
