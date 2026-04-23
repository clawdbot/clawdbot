import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveOpenClawAgentDir } from "openclaw/plugin-sdk/provider-auth";
import { prepareCodexAuthBridge } from "openclaw/plugin-sdk/provider-auth-runtime";
import { writePrivateSecretFileAtomic } from "openclaw/plugin-sdk/secret-file-runtime";
import type { PluginLogger } from "../runtime-api.js";
import type { ResolvedAcpxPluginConfig } from "./config.js";

const CODEX_AGENT_ID = "codex";
const DEFAULT_CODEX_AUTH_PROFILE_ID = "openai-codex:default";
// acpx selects ACP auth methods from the OpenClaw process env before the wrapper
// launches. Keep those env vars visible to the child so its auth method matches.
const CODEX_AUTH_ENV_CLEAR_KEYS: string[] = [];

type PreparedAcpxCodexAuth = {
  codexHome: string;
  clearEnv: string[];
};

function resolveSourceCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME?.trim();
  if (configured) {
    if (configured === "~") {
      return os.homedir();
    }
    if (configured.startsWith("~/")) {
      return path.join(os.homedir(), configured.slice(2));
    }
    return path.resolve(configured);
  }
  return path.join(os.homedir(), ".codex");
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function prepareCopiedCodexHome(params: {
  agentDir: string;
  sourceCodexHome: string;
}): Promise<PreparedAcpxCodexAuth | null> {
  const authJson = await readOptionalFile(path.join(params.sourceCodexHome, "auth.json"));
  if (!authJson) {
    return null;
  }

  const codexHome = path.join(params.agentDir, "acp-auth", "codex-source");
  await writePrivateSecretFileAtomic({
    rootDir: params.agentDir,
    filePath: path.join(codexHome, "auth.json"),
    content: authJson,
  });

  const configToml = await readOptionalFile(path.join(params.sourceCodexHome, "config.toml"));
  if (configToml) {
    await writePrivateSecretFileAtomic({
      rootDir: params.agentDir,
      filePath: path.join(codexHome, "config.toml"),
      content: configToml,
    });
  }

  return {
    codexHome,
    clearEnv: [...CODEX_AUTH_ENV_CLEAR_KEYS],
  };
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function writeCodexAcpWrapper(params: {
  wrapperPath: string;
  codexHome: string;
  clearEnv: string[];
}): Promise<string> {
  await fs.mkdir(path.dirname(params.wrapperPath), { recursive: true, mode: 0o700 });
  const content = `#!/usr/bin/env node
import { spawn } from "node:child_process";

const env = { ...process.env, CODEX_HOME: ${JSON.stringify(params.codexHome)} };
for (const key of ${JSON.stringify(params.clearEnv)}) {
  delete env[key];
}

const child = spawn("npx", ["@zed-industries/codex-acp@^0.11.1"], {
  stdio: "inherit",
  env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
`;
  await fs.writeFile(params.wrapperPath, content, { mode: 0o700 });
  await fs.chmod(params.wrapperPath, 0o700);
  return shellArg(params.wrapperPath);
}

export async function prepareAcpxCodexAuthConfig(params: {
  pluginConfig: ResolvedAcpxPluginConfig;
  stateDir: string;
  logger?: PluginLogger;
}): Promise<ResolvedAcpxPluginConfig> {
  if (params.pluginConfig.agents[CODEX_AGENT_ID]) {
    return params.pluginConfig;
  }

  const agentDir = resolveOpenClawAgentDir();
  const sourceCodexHome = resolveSourceCodexHome();
  const bridge =
    (await prepareCodexAuthBridge({
      agentDir,
      bridgeDir: "acp-auth",
      profileId: DEFAULT_CODEX_AUTH_PROFILE_ID,
      sourceCodexHome,
    })) ??
    (await prepareCopiedCodexHome({
      agentDir,
      sourceCodexHome,
    }));

  if (!bridge) {
    params.logger?.debug?.("codex ACP auth bridge skipped: no Codex auth source found");
    return params.pluginConfig;
  }

  const wrapperCommand = await writeCodexAcpWrapper({
    wrapperPath: path.join(params.stateDir, "acpx", "codex-acp-wrapper.mjs"),
    codexHome: bridge.codexHome,
    clearEnv: bridge.clearEnv,
  });

  return {
    ...params.pluginConfig,
    agents: {
      ...params.pluginConfig.agents,
      [CODEX_AGENT_ID]: wrapperCommand,
    },
  };
}
