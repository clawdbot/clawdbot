import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { resolveEffectiveToolPolicy } from "../agents/agent-tools.policy.js";
import { resolveExecToolConfig } from "../agents/lazy-exec-tool.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../agents/tool-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SystemAgentConfiguredRoute } from "../system-agent/inference-route.js";
import { sanitizeHostExecEnv } from "./host-env-security.js";
import {
  installationTargetEnv,
  withInstallationTarget,
  LOCAL_INSTALLATION_TARGET_UNSUPPORTED,
} from "./installation-target-context.js";
import type { UpdateRepairTarget } from "./update-repair-protocol.js";
import { buildUpdateDoctorEnv } from "./update-runner-doctor.js";

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
  if (target.environment) {
    // Rehearsal may clear live selectors, but only its isolation paths can
    // override the host environment. Keep executable lookup and credentials host-owned.
    const environment: NodeJS.ProcessEnv = {};
    for (const key of Object.keys(process.env)) {
      if (target.environment[key] !== undefined) {
        environment[key] = process.env[key];
      }
    }
    for (const key of [
      "HOME",
      "USERPROFILE",
      "TMPDIR",
      "TMP",
      "TEMP",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "OPENCLAW_HOME",
      "OPENCLAW_AGENT_DIR",
      "PI_CODING_AGENT_DIR",
    ]) {
      environment[key] = target.environment[key];
    }
    const sanitized = sanitizeHostExecEnv({ baseEnv: environment });
    for (const key of Object.keys(process.env)) {
      if (sanitized[key] === undefined) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, sanitized);
  }
  Object.assign(
    process.env,
    installationTargetEnv({
      stateDir: target.stateDir,
      configPath: target.configPath,
      defaultWorkspaceDir: target.workspaceDir,
    }),
    buildUpdateDoctorEnv({
      allowGatewayServiceRepair: false,
      allowGatewayActivation: false,
      serviceRepairPolicy: "external",
      deferConfiguredPluginInstallRepair: Boolean(target.environment),
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

// Operator-owned updates permit prompt-free exec, never past an explicit deny.
// The repair workspace and filesystem tools stay within the install/candidate root;
// host commands must follow that same scope contract.
function repairRunConfig(
  route: SystemAgentConfiguredRoute,
  fallbacks: string[],
): Result<{ runConfig: OpenClawConfig; modelFallbacks: string[] }, string> {
  const base = route.runConfig;
  const exec = resolveExecToolConfig({ cfg: base, agentId: route.agentId });
  if (
    resolveSandboxConfigForAgent(base, route.agentId).mode !== "off" ||
    exec.host === "node" ||
    exec.host === "sandbox"
  ) {
    return err(LOCAL_INSTALLATION_TARGET_UNSUPPORTED);
  }
  const allowedToolsForModel = (modelProvider: string, modelId: string) => {
    const policy = resolveEffectiveToolPolicy({
      config: base,
      agentId: route.agentId,
      modelProvider,
      modelId,
    });
    const policies = [
      policy.globalPolicy,
      policy.agentPolicy,
      policy.globalProviderPolicy,
      policy.agentProviderPolicy,
      mergeAlsoAllowPolicy(resolveToolProfilePolicy(policy.profile), policy.profileAlsoAllow),
      mergeAlsoAllowPolicy(
        resolveToolProfilePolicy(policy.providerProfile),
        policy.providerProfileAlsoAllow,
      ),
    ];
    return ["exec", "process", "read", "write", "edit", "apply_patch"].filter((tool) =>
      isToolAllowedByPolicies(tool, policies),
    );
  };
  const permitsRepair = (tools: string[]) =>
    ["exec", "write", "edit", "apply_patch"].every((tool) => tools.includes(tool));
  const allowedTools = allowedToolsForModel(route.provider, route.model);
  if (exec.security === "deny" || !permitsRepair(allowedTools)) {
    return err("exec-denied-by-policy");
  }
  // Inference selection supplies canonical provider/model refs. A fallback must
  // pass the same repair gate before it can inherit prompt-free host execution.
  const modelFallbacks = fallbacks.filter((ref) => {
    const slash = ref.indexOf("/");
    return permitsRepair(allowedToolsForModel(ref.slice(0, slash), ref.slice(slash + 1)));
  });
  const localExec = {
    host: "gateway" as const,
    mode: "full" as const,
    security: undefined,
    ask: undefined,
    node: undefined,
  };
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
  return ok({
    modelFallbacks,
    runConfig: {
      ...base,
      agents: {
        ...base.agents,
        defaults: {
          ...base.agents?.defaults,
          models: { ...base.agents?.defaults?.models, ...nativeModels },
        },
        entries: Object.fromEntries(
          Object.entries(base.agents?.entries ?? {}).map(([id, entry]) => [
            id,
            {
              ...entry,
              models: { ...entry.models, ...nativeModels },
              tools: {
                ...entry.tools,
                exec: { ...entry.tools?.exec, ...localExec },
                fs: { ...entry.tools?.fs, workspaceOnly: true },
              },
            },
          ]),
        ),
      },
      tools: {
        ...base.tools,
        profile: base.tools?.profile ?? "coding",
        allow: allowedTools,
        alsoAllow: base.tools?.alsoAllow?.length ? allowedTools : undefined,
        exec: { ...base.tools?.exec, ...localExec },
        fs: { ...base.tools?.fs, workspaceOnly: true },
      },
    },
  });
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
  params.signal.throwIfAborted();
  const { route, target } = params;
  const config = repairRunConfig(route, params.modelFallbacks);
  if (!config.ok) {
    return { status: "unavailable" as const, reason: config.error };
  }
  const { runConfig, modelFallbacks } = config.value;
  const { agentExecCommand } = await import("../commands/agent-exec.js");
  const result = await withInstallationTarget(
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
          fallback: modelFallbacks,
          codeMode: "direct",
        },
        repairRuntime,
        {
          baseConfig: runConfig,
          modelFallbacksOverride: modelFallbacks,
          agentId: route.agentId,
          abortSignal: params.signal,
          timeoutMs: params.timeoutMs,
          maxToolCalls: params.maxToolCalls,
          isCurrent: params.isCurrent,
        },
      ),
  );
  return { status: "completed" as const, ...result };
}
