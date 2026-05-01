import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureEnv } from "./env.js";
import { cleanupSessionStateForTest } from "./session-state-cleanup.js";

export type OpenClawTestStateLayout = "home" | "state-only" | "split";

export type OpenClawTestStateScenario =
  | "empty"
  | "minimal"
  | "update-stable"
  | "upgrade-survivor"
  | "gateway-loopback"
  | "external-service";

export type OpenClawTestStateOptions = {
  prefix?: string;
  label?: string;
  layout?: OpenClawTestStateLayout;
  scenario?: OpenClawTestStateScenario;
  agentEnv?: "clear" | "main";
  applyEnv?: boolean;
  env?: Record<string, string | undefined>;
  gateway?: {
    port?: number;
    token?: string;
  };
};

export type OpenClawTestState = {
  root: string;
  home: string;
  stateDir: string;
  configPath: string;
  workspaceDir: string;
  env: NodeJS.ProcessEnv;
  envVars: Record<string, string | undefined>;
  path: (...parts: string[]) => string;
  statePath: (...parts: string[]) => string;
  agentDir: (agentId?: string) => string;
  sessionsDir: (agentId?: string) => string;
  writeConfig: (config: unknown) => Promise<string>;
  writeJson: (relativePath: string, value: unknown) => Promise<string>;
  writeText: (relativePath: string, value: string) => Promise<string>;
  writeAuthProfiles: (store: unknown, agentId?: string) => Promise<string>;
  applyEnv: () => void;
  restoreEnv: () => void;
  cleanup: () => Promise<void>;
};

const DEFAULT_PREFIX = "openclaw-test-state-";
const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
  "OPENCLAW_SERVICE_REPAIR_POLICY",
] as const;

function normalizeLabel(value: string | undefined): string {
  return (value ?? "state").replace(/[^A-Za-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "state";
}

function resolveWindowsHomeEnv(
  home: string,
): Partial<Pick<NodeJS.ProcessEnv, "HOMEDRIVE" | "HOMEPATH">> {
  if (process.platform !== "win32") {
    return {};
  }
  const match = home.match(/^([A-Za-z]:)(.*)$/u);
  if (!match) {
    return {};
  }
  return {
    HOMEDRIVE: match[1],
    HOMEPATH: match[2] || "\\",
  };
}

function resolveLayout(
  root: string,
  layout: OpenClawTestStateLayout,
): {
  home: string;
  stateDir: string;
  configPath: string;
  workspaceDir: string;
} {
  if (layout === "home") {
    const home = path.join(root, "home");
    const stateDir = path.join(home, ".openclaw");
    return {
      home,
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
      workspaceDir: path.join(home, "workspace"),
    };
  }
  if (layout === "split") {
    const home = path.join(root, "home");
    const stateDir = path.join(root, "state");
    return {
      home,
      stateDir,
      configPath: path.join(root, "config", "openclaw.json"),
      workspaceDir: path.join(root, "workspace"),
    };
  }
  const stateDir = path.join(root, "state");
  return {
    home: path.join(root, "home"),
    stateDir,
    configPath: path.join(stateDir, "openclaw.json"),
    workspaceDir: path.join(root, "workspace"),
  };
}

function scenarioConfig(options: OpenClawTestStateOptions): Record<string, unknown> | undefined {
  const scenario = options.scenario ?? "empty";
  if (scenario === "minimal" || scenario === "external-service") {
    return {};
  }
  if (scenario === "update-stable") {
    return {
      update: {
        channel: "stable",
      },
      plugins: {},
    };
  }
  if (scenario === "upgrade-survivor") {
    return {
      update: {
        channel: "stable",
      },
      gateway: {
        port: options.gateway?.port ?? 18789,
        bind: "loopback",
        auth: {
          mode: "token",
          token: options.gateway?.token ?? "openclaw-test-token",
        },
        controlUi: {
          enabled: false,
        },
      },
      plugins: {
        enabled: true,
        allow: ["discord", "telegram", "whatsapp", "memory"],
        entries: {
          discord: { enabled: true },
          telegram: { enabled: true },
          whatsapp: { enabled: true },
        },
      },
    };
  }
  if (scenario === "gateway-loopback") {
    return {
      gateway: {
        port: options.gateway?.port ?? 18789,
        auth: {
          mode: "token",
          token: options.gateway?.token ?? "openclaw-test-token",
        },
        controlUi: {
          enabled: false,
        },
      },
    };
  }
  return undefined;
}

function scenarioEnv(options: OpenClawTestStateOptions): Record<string, string | undefined> {
  if ((options.scenario ?? "empty") === "external-service") {
    return {
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    };
  }
  return {};
}

function buildEnvVars(params: {
  layout: OpenClawTestStateLayout;
  home: string;
  stateDir: string;
  configPath: string;
  agentDir: string;
  agentEnv: "clear" | "main";
  scenarioEnv: Record<string, string | undefined>;
  extraEnv: Record<string, string | undefined>;
}): Record<string, string | undefined> {
  const agentDirEnv =
    params.agentEnv === "main"
      ? {
          OPENCLAW_AGENT_DIR: params.agentDir,
          PI_CODING_AGENT_DIR: params.agentDir,
        }
      : {
          OPENCLAW_AGENT_DIR: undefined,
          PI_CODING_AGENT_DIR: undefined,
        };
  const envVars: Record<string, string | undefined> = {
    OPENCLAW_STATE_DIR: params.stateDir,
    OPENCLAW_CONFIG_PATH: params.configPath,
    ...agentDirEnv,
    ...params.scenarioEnv,
    ...params.extraEnv,
  };
  if (params.layout !== "state-only") {
    Object.assign(envVars, {
      HOME: params.home,
      USERPROFILE: params.home,
      OPENCLAW_HOME: params.home,
      ...resolveWindowsHomeEnv(params.home),
    });
  }
  return envVars;
}

function createSpawnEnv(envVars: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(envVars)) {
    if (value === undefined) {
      delete nextEnv[key];
    } else {
      nextEnv[key] = value;
    }
  }
  return nextEnv;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

export async function createOpenClawTestState(
  options: OpenClawTestStateOptions = {},
): Promise<OpenClawTestState> {
  const label = normalizeLabel(options.label ?? options.scenario);
  const prefix = options.prefix ?? `${DEFAULT_PREFIX}${label}-`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const layout = options.layout ?? "home";
  const paths = resolveLayout(root, layout);

  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.mkdir(paths.workspaceDir, { recursive: true });
  if (layout !== "state-only") {
    await fs.mkdir(paths.home, { recursive: true });
  }

  const config = scenarioConfig(options);
  if (config !== undefined) {
    await writeJsonFile(paths.configPath, config);
  }

  const mainAgentDir = path.join(paths.stateDir, "agents", "main", "agent");
  const envVars = buildEnvVars({
    layout,
    home: paths.home,
    stateDir: paths.stateDir,
    configPath: paths.configPath,
    agentDir: mainAgentDir,
    agentEnv: options.agentEnv ?? "clear",
    scenarioEnv: scenarioEnv(options),
    extraEnv: options.env ?? {},
  });
  const env = createSpawnEnv(envVars);
  const snapshot = captureEnv([...new Set([...ENV_KEYS, ...Object.keys(envVars)])]);
  let envApplied = false;
  let cleaned = false;
  const agentDir = (agentId = "main") => path.join(paths.stateDir, "agents", agentId, "agent");
  const sessionsDir = (agentId = "main") =>
    path.join(paths.stateDir, "agents", agentId, "sessions");

  const state: OpenClawTestState = {
    root,
    ...paths,
    env,
    envVars,
    path: (...parts) => path.join(root, ...parts),
    statePath: (...parts) => path.join(paths.stateDir, ...parts),
    agentDir,
    sessionsDir,
    writeConfig: (value) => writeJsonFile(paths.configPath, value),
    writeJson: (relativePath, value) =>
      writeJsonFile(path.join(paths.stateDir, relativePath), value),
    writeText: async (relativePath, value) => {
      const filePath = path.join(paths.stateDir, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, value, "utf8");
      return filePath;
    },
    writeAuthProfiles: (store, agentId = "main") => {
      const filePath = path.join(agentDir(agentId), "auth-profiles.json");
      return writeJsonFile(filePath, store);
    },
    applyEnv: () => {
      for (const [key, value] of Object.entries(envVars)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      envApplied = true;
    },
    restoreEnv: () => {
      if (envApplied) {
        snapshot.restore();
        envApplied = false;
      }
    },
    cleanup: async () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      await cleanupSessionStateForTest().catch(() => undefined);
      state.restoreEnv();
      await fs.rm(root, { recursive: true, force: true });
    },
  };

  if (options.applyEnv !== false) {
    state.applyEnv();
  }

  return state;
}

export async function withOpenClawTestState<T>(
  options: OpenClawTestStateOptions,
  fn: (state: OpenClawTestState) => Promise<T>,
): Promise<T> {
  const state = await createOpenClawTestState(options);
  try {
    return await fn(state);
  } finally {
    await state.cleanup();
  }
}
