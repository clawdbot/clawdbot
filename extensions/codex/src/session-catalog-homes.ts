import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listAgentIds, resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerLocalHomeDir,
} from "./app-server/auth-start-options.js";
import {
  resolveCodexAppServerUserHomeDir,
  resolveCodexSupervisionAppServerRuntimeOptions,
} from "./app-server/config.js";
import {
  buildCodexAppServerConnectionFingerprint,
  replaceCodexCatalogConnectionHomes,
} from "./app-server/plugin-app-cache-key.js";
import { CODEX_LOCAL_SESSION_HOST_ID, MAX_HOST_COUNT } from "./session-catalog-parsing.js";
import type { CodexCatalogHome } from "./session-catalog-types.js";

export type { CodexCatalogHome } from "./session-catalog-types.js";

type CatalogHomeCandidate = {
  codexHome: string;
  label: string;
  usesProcessHomeFallback: boolean;
};

function canonicalCatalogHome(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function catalogHomeId(codexHome: string): string {
  return createHash("sha256")
    .update("openclaw:codex-session-catalog-home:v1\0")
    .update(codexHome)
    .digest("hex");
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
  const base = resolveCodexSupervisionAppServerRuntimeOptions({
    pluginConfig,
    env,
    agentDir: ownerAgentDir,
    config,
  });
  const primaryCodexHome = canonicalCatalogHome(
    resolveCodexAppServerLocalHomeDir(base.start, ownerAgentDir, env),
  );
  const processUserHome = canonicalCatalogHome(resolveCodexAppServerUserHomeDir(env));
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
      ...agentIds.flatMap((agentId) => {
        const codexHome = canonicalCatalogHome(
          resolveCodexAppServerHomeDir(resolveAgentDir(config, agentId, env)),
        );
        return fs.existsSync(codexHome)
          ? [{ codexHome, label: `Local Codex · ${agentId}`, usesProcessHomeFallback: false }]
          : [];
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
    const sourceHomeId = catalogHomeId(candidate.codexHome);
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
      usesProcessHomeFallback: candidate.usesProcessHomeFallback,
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
