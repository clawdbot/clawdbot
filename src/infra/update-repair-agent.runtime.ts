import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SystemAgentConfiguredRoute } from "../system-agent/inference-route.js";
import {
  installationTargetEnv,
  withInstallationTarget,
  LOCAL_INSTALLATION_TARGET_UNSUPPORTED,
} from "./installation-target-context.js";
import type { UpdateRepairTarget } from "./update-repair-agent.js";

const repairRuntime = {
  log: () => {},
  error: () => {},
  exit: (code: number): never => {
    throw new Error(`Repair agent exited (${code}).`);
  },
};

/** The orchestrator serializes this phase; restore every config-load env effect. */
export async function withUpdateRepairEnvironment<T>(
  target: UpdateRepairTarget,
  run: () => Promise<T>,
): Promise<T> {
  const [io, paths] = await Promise.all([import("../config/io.js"), import("../config/paths.js")]);
  const previousConfig = io.getRuntimeConfigSnapshot();
  const previousEnv = io.snapshotEnv(process.env);
  Object.assign(
    process.env,
    installationTargetEnv({
      stateDir: target.stateDir,
      configPath: target.configPath,
      defaultWorkspaceDir: target.workspaceDir,
    }),
  );
  io.clearRuntimeConfigSnapshot();
  paths.pinRuntimePaths();
  try {
    return await run();
  } finally {
    io.restoreEnvChangesIfUnchanged({
      env: process.env,
      before: previousEnv,
      after: io.snapshotEnv(process.env),
    });
    if (previousConfig) {
      io.setRuntimeConfigSnapshot(previousConfig);
    } else {
      io.clearRuntimeConfigSnapshot();
    }
    paths.pinRuntimePaths();
  }
}

export async function prepareUpdateRepairInference(signal: AbortSignal, timeoutMs: number) {
  const [{ getRuntimeConfig }, { selectUpdateRepairInference }] = await Promise.all([
    import("../config/io.js"),
    import("./update-repair-inference.js"),
  ]);
  try {
    signal.throwIfAborted();
    const config = getRuntimeConfig();
    return await selectUpdateRepairInference({ config, runtime: repairRuntime, signal, timeoutMs });
  } catch {
    return {
      ok: false as const,
      reason:
        "The target configuration could not provide a usable inference route. Check model setup.",
    };
  }
}

function repairRunConfig(
  route: SystemAgentConfiguredRoute,
  modelFallbacks: string[],
): OpenClawConfig {
  const base = route.runConfig;
  const localExec = {
    ...base.tools?.exec,
    host: "gateway" as const,
    mode: "full" as const,
    security: undefined,
    ask: undefined,
    node: undefined,
  };
  const allowedTools = ["exec", "process", "read", "write", "edit", "apply_patch"];
  const nativeModels = Object.fromEntries(
    [route.modelLabel, ...modelFallbacks].map((ref) => [
      ref,
      {
        ...base.agents?.defaults?.models?.[ref],
        ...base.agents?.entries?.[route.agentId]?.models?.[ref],
        agentRuntime: { id: "openclaw" },
      },
    ]),
  );
  const repairTools = {
    profile: "coding" as const,
    allow: allowedTools,
    deny: [],
    byProvider: {},
    exec: localExec,
    fs: { workspaceOnly: false },
  };
  return {
    ...base,
    agents: {
      ...base.agents,
      defaults: {
        ...base.agents?.defaults,
        sandbox: { mode: "off" },
        models: { ...base.agents?.defaults?.models, ...nativeModels },
      },
      entries: Object.fromEntries(
        Object.entries(base.agents?.entries ?? {}).map(([id, entry]) => [
          id,
          {
            ...entry,
            sandbox: { mode: "off" },
            models: { ...entry.models, ...nativeModels },
            tools: {
              ...entry.tools,
              ...repairTools,
            },
          },
        ]),
      ),
    },
    tools: { ...base.tools, ...repairTools },
  };
}

export async function runUpdateRepairTurn(params: {
  target: UpdateRepairTarget;
  route: Extract<SystemAgentConfiguredRoute, { runner: "embedded" }>;
  modelFallbacks: string[];
  prompt: string;
  timeoutMs: number;
  maxToolCalls: number;
  signal: AbortSignal;
  isCurrent?: () => boolean;
}) {
  const [{ agentExecCommand }, { resolveSandboxConfigForAgent }, { resolveExecToolConfig }] =
    await Promise.all([
      import("../commands/agent-exec.js"),
      import("../agents/sandbox/config.js"),
      import("../agents/lazy-exec-tool.js"),
    ]);
  params.signal.throwIfAborted();
  const { route, target } = params;
  const host = resolveExecToolConfig({ cfg: route.runConfig, agentId: route.agentId }).host;
  // A local repair must not silently bypass the operator's configured isolation.
  // Only after this refusal gate may its disposable snapshot enable unattended exec.
  if (
    resolveSandboxConfigForAgent(route.runConfig, route.agentId).mode !== "off" ||
    host === "node" ||
    host === "sandbox"
  ) {
    throw new Error(LOCAL_INSTALLATION_TARGET_UNSUPPORTED);
  }
  return withInstallationTarget(
    {
      stateDir: target.stateDir,
      configPath: target.configPath,
      defaultWorkspaceDir: target.workspaceDir,
    },
    () =>
      agentExecCommand(
        params.prompt,
        {
          cwd: target.candidateRoot ?? target.installRoot,
          model: route.modelLabel,
          fallback: params.modelFallbacks,
          codeMode: "direct",
        },
        repairRuntime,
        {
          baseConfig: repairRunConfig(route, params.modelFallbacks),
          modelFallbacksOverride: params.modelFallbacks,
          agentId: route.agentId,
          abortSignal: params.signal,
          timeoutMs: params.timeoutMs,
          maxToolCalls: params.maxToolCalls,
          isCurrent: params.isCurrent,
        },
      ),
  );
}
