/**
 * Sandbox context resolver.
 *
 * Prepares workspace layout, backend handle, filesystem bridge, browser bridge, and registry state for one run.
 */
import fs from "node:fs/promises";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  ensureBrowserControlAuth,
  resolveBrowserControlAuth,
} from "../../plugin-sdk/browser-control-auth.js";
import {
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  resolveBrowserConfig,
} from "../../plugin-sdk/browser-profiles.js";
import { defaultRuntime } from "../../runtime.js";
import { createLazyRuntimeNamedExport } from "../../shared/lazy-runtime.js";
import type { SkillEligibilityContext, SkillSnapshot, SkillUsagePath } from "../../skills/types.js";
import type { ExecPolicyOverrides } from "../exec-defaults.js";
import { getSandboxBackendWorkdirResolver, requireSandboxBackendFactory } from "./backend.js";
import { ensureSandboxBrowser } from "./browser.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { resolveSandboxDockerUser } from "./docker-user.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import { toSandboxProvisioningError } from "./provisioning-error.js";
import { readRegisteredSandboxRuntimeIds, updateRegistry } from "./registry.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";
import { assertSshSandboxSecretOwnerAvailable } from "./secret-owner.js";
import { resolveSandboxWorkspaceLayoutPaths } from "./shared.js";
import type { SandboxContext, SandboxIsolationSubject, SandboxWorkspaceInfo } from "./types.js";
import { ensureSandboxWorkspace } from "./workspace.js";

const sandboxLog = createSubsystemLogger("agent/sandbox");

const loadSyncWorkspaceSkills = createLazyRuntimeNamedExport(
  () => import("../../skills/loading/workspace-skill-sync.runtime.js"),
  "syncWorkspaceSkills",
);

async function syncSandboxSkillsToWorkspace(params: {
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
  config?: OpenClawConfig;
  agentId: string;
  rawSessionKey: string;
  execOverrides?: ExecPolicyOverrides;
  skillsSnapshot?: SkillSnapshot;
}): Promise<{ eligibility?: SkillEligibilityContext; skillUsagePaths?: SkillUsagePath[] }> {
  try {
    const [syncWorkspaceSkills, { getRemoteSkillEligibility }, { resolveNodeExecEligibility }] =
      await Promise.all([
        loadSyncWorkspaceSkills(),
        import("../../skills/runtime/remote.js"),
        import("../exec-defaults.js"),
      ]);
    const nodeSkills = resolveNodeExecEligibility({
      cfg: params.config,
      sessionKey: params.rawSessionKey,
      agentId: params.agentId,
      execOverrides: params.execOverrides,
    });
    const eligibility: SkillEligibilityContext = {
      nodeSkills,
      remote: getRemoteSkillEligibility({
        advertiseExecNode: nodeSkills.canExec,
      }),
    };
    const skillUsagePaths = await syncWorkspaceSkills({
      sourceWorkspaceDir: params.sourceWorkspaceDir,
      targetWorkspaceDir: params.targetWorkspaceDir,
      config: params.config,
      agentId: params.agentId,
      eligibility,
      skillsSnapshot: params.skillsSnapshot,
    });
    return { eligibility, skillUsagePaths };
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    defaultRuntime.error?.(`Sandbox skill sync failed: ${message}`);
    return {};
  }
}

async function ensureSandboxWorkspaceLayout(params: {
  cfg: ReturnType<typeof resolveSandboxConfigForAgent>;
  agentId: string;
  rawSessionKey: string;
  isolationSubject?: SandboxIsolationSubject;
  config?: OpenClawConfig;
  execOverrides?: ExecPolicyOverrides;
  skillsSnapshot?: SkillSnapshot;
  workspaceDir?: string;
}): Promise<{
  agentWorkspaceDir: string;
  scopeKey: string;
  sandboxWorkspaceDir: string;
  skillsWorkspaceDir: string;
  skillsEligibility?: SkillEligibilityContext;
  skillUsagePaths?: SkillUsagePath[];
  workspaceDir: string;
}> {
  const { cfg, rawSessionKey } = params;
  const { agentWorkspaceDir, sandboxWorkspaceDir, scopeKey, skillsWorkspaceDir, workspaceDir } =
    resolveSandboxWorkspaceLayoutPaths({
      cfg,
      rawSessionKey,
      agentId: params.agentId,
      isolationSubject: params.isolationSubject,
      workspaceDir: params.workspaceDir,
    });

  let syncedSkills: Awaited<ReturnType<typeof syncSandboxSkillsToWorkspace>>;
  if (cfg.workspaceAccess !== "rw") {
    await ensureSandboxWorkspace(
      sandboxWorkspaceDir,
      agentWorkspaceDir,
      params.config?.agents?.defaults?.skipBootstrap,
      params.config?.agents?.defaults?.skipOptionalBootstrapFiles,
    );
    syncedSkills = await syncSandboxSkillsToWorkspace({
      sourceWorkspaceDir: agentWorkspaceDir,
      targetWorkspaceDir: sandboxWorkspaceDir,
      config: params.config,
      agentId: params.agentId,
      rawSessionKey,
      execOverrides: params.execOverrides,
      skillsSnapshot: params.skillsSnapshot,
    });
  } else {
    await fs.mkdir(workspaceDir, { recursive: true });
    syncedSkills = await syncSandboxSkillsToWorkspace({
      sourceWorkspaceDir: agentWorkspaceDir,
      targetWorkspaceDir: skillsWorkspaceDir,
      config: params.config,
      agentId: params.agentId,
      rawSessionKey,
      execOverrides: params.execOverrides,
      skillsSnapshot: params.skillsSnapshot,
    });
  }

  return {
    agentWorkspaceDir,
    scopeKey,
    sandboxWorkspaceDir,
    skillsWorkspaceDir,
    ...(syncedSkills.eligibility ? { skillsEligibility: syncedSkills.eligibility } : {}),
    ...(syncedSkills.skillUsagePaths ? { skillUsagePaths: syncedSkills.skillUsagePaths } : {}),
    workspaceDir,
  };
}

function resolveSandboxSession(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}) {
  const rawSessionKey = params.sessionKey?.trim();
  if (!rawSessionKey) {
    return null;
  }

  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    agentId: params.agentId,
    sessionKey: rawSessionKey,
  });
  if (!runtime.sandboxed) {
    return null;
  }

  const configuredSandbox = resolveSandboxConfigForAgent(params.config, runtime.agentId);
  if (!runtime.sandboxRequired) {
    return { rawSessionKey, runtime, cfg: configuredSandbox };
  }
  if (configuredSandbox.workspaceAccess === "rw") {
    sandboxLog.warn(
      'Configured sandbox workspaceAccess "rw" is capped to "ro" for a role-required session; guests cannot share the writable agent workspace.',
    );
  }
  // Docker and browser backends replace shared scope keys with a literal name;
  // agent scope lets the prepared isolation subject own every sandbox resource.
  const cfg = {
    ...configuredSandbox,
    scope: "agent" as const,
    workspaceAccess: runtime.workspaceAccess,
  };
  return { rawSessionKey, runtime, cfg };
}

function resolveSandboxWorkspaceInfoWorkdir(params: {
  cfg: ReturnType<typeof resolveSandboxConfigForAgent>;
  rawSessionKey: string;
  scopeKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir: string;
}): string | undefined {
  return getSandboxBackendWorkdirResolver(params.cfg.backend)?.({
    sessionKey: params.rawSessionKey,
    scopeKey: params.scopeKey,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    cfg: params.cfg,
  });
}

type ResolveSandboxContextParams = {
  config?: OpenClawConfig;
  agentId?: string;
  execOverrides?: ExecPolicyOverrides;
  requireCurrentConfig?: boolean;
  sessionKey?: string;
  skillsSnapshot?: SkillSnapshot;
  workspaceDir?: string;
};

type ResolvedSandboxSession = NonNullable<ReturnType<typeof resolveSandboxSession>>;

function assertSandboxSessionSecretOwnerAvailable(
  config: OpenClawConfig | undefined,
  resolved: ResolvedSandboxSession,
): void {
  if (resolved.cfg.backend !== "ssh") {
    return;
  }
  // Never let an unresolved inline SSH credential silently fall through to
  // ambient host SSH identities for this agent.
  assertSshSandboxSecretOwnerAvailable({
    config,
    scope: resolved.cfg.scope,
    agentId: resolved.runtime.agentId,
  });
}

async function resolveProvisionedSandboxContext(
  params: ResolveSandboxContextParams,
  resolved: ResolvedSandboxSession,
): Promise<SandboxContext> {
  const { rawSessionKey, cfg, runtime } = resolved;

  if (cfg.prune.idleHours !== 0 || cfg.prune.maxAgeDays !== 0) {
    await (await import("./prune.js")).maybePruneSandboxes(cfg);
  }

  const {
    agentWorkspaceDir,
    scopeKey,
    skillsEligibility,
    skillUsagePaths,
    skillsWorkspaceDir,
    workspaceDir,
  } = await ensureSandboxWorkspaceLayout({
    cfg,
    agentId: runtime.agentId,
    rawSessionKey,
    isolationSubject: runtime.isolationSubject,
    config: params.config,
    execOverrides: params.execOverrides,
    skillsSnapshot: params.skillsSnapshot,
    workspaceDir: params.workspaceDir,
  });

  const docker = await resolveSandboxDockerUser({
    backend: cfg.backend,
    docker: cfg.docker,
    workspaceDir,
  });
  const resolvedCfg = docker === cfg.docker ? cfg : { ...cfg, docker };

  const backendFactory = requireSandboxBackendFactory(resolvedCfg.backend);
  const registeredRuntimeIds = await readRegisteredSandboxRuntimeIds({
    backendId: resolvedCfg.backend,
    scopeKey,
  });
  const backend = await backendFactory({
    sessionKey: rawSessionKey,
    scopeKey,
    ...(registeredRuntimeIds.length > 0 ? { registeredRuntimeIds } : {}),
    workspaceDir,
    agentWorkspaceDir,
    skillsWorkspaceDir,
    cfg: resolvedCfg,
    ...(params.requireCurrentConfig !== undefined
      ? { requireCurrentConfig: params.requireCurrentConfig }
      : {}),
  });
  await updateRegistry({
    containerName: backend.runtimeId,
    backendId: backend.id,
    runtimeLabel: backend.runtimeLabel,
    sessionKey: scopeKey,
    createdAtMs: Date.now(),
    lastUsedAtMs: Date.now(),
    image: backend.configLabel ?? resolvedCfg.docker.image,
    configLabelKind: backend.configLabelKind ?? "Image",
  });

  const resolvedBrowserConfig = resolvedCfg.browser.enabled
    ? resolveBrowserConfig(params.config?.browser, params.config)
    : undefined;
  const evaluateEnabled =
    resolvedBrowserConfig?.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED;

  const bridgeAuth = cfg.browser.enabled
    ? await (async () => {
        // Sandbox browser bridge server runs on a loopback TCP port; always wire up
        // the same auth that loopback browser clients will send (token/password).
        const cfgForAuth =
          params.config ?? (await import("../../config/config.js")).getRuntimeConfig();
        let browserAuth = resolveBrowserControlAuth(cfgForAuth);
        try {
          const ensured = await ensureBrowserControlAuth({ cfg: cfgForAuth });
          browserAuth = ensured.auth;
        } catch (error) {
          const message = error instanceof Error ? error.message : JSON.stringify(error);
          defaultRuntime.error?.(`Sandbox browser auth ensure failed: ${message}`);
        }
        return browserAuth;
      })()
    : undefined;
  if (resolvedCfg.browser.enabled && backend.capabilities?.browser !== true) {
    throw new Error(`Sandbox backend "${backend.id}" does not support browser sandboxes yet.`);
  }
  const browser =
    resolvedCfg.browser.enabled && backend.capabilities?.browser === true
      ? await ensureSandboxBrowser({
          scopeKey,
          workspaceDir,
          agentWorkspaceDir,
          skillsWorkspaceDir,
          cfg: resolvedCfg,
          evaluateEnabled,
          bridgeAuth,
          ssrfPolicy: resolvedBrowserConfig?.ssrfPolicy,
        })
      : null;

  const sandboxContext: SandboxContext = {
    enabled: true,
    ...(runtime.sandboxRequired ? { required: true } : {}),
    backendId: backend.id,
    sessionKey: rawSessionKey,
    workspaceDir,
    agentWorkspaceDir,
    skillsWorkspaceDir,
    ...(skillsEligibility ? { skillsEligibility } : {}),
    ...(skillUsagePaths ? { skillUsagePaths } : {}),
    workspaceAccess: resolvedCfg.workspaceAccess,
    runtimeId: backend.runtimeId,
    runtimeLabel: backend.runtimeLabel,
    containerName: backend.runtimeId,
    containerWorkdir: backend.workdir,
    docker: resolvedCfg.docker,
    tools: resolvedCfg.tools,
    browserAllowHostControl: resolvedCfg.browser.allowHostControl,
    browser: browser ?? undefined,
    backend,
  };

  sandboxContext.fsBridge =
    backend.createFsBridge?.({ sandbox: sandboxContext }) ??
    createSandboxFsBridge({ sandbox: sandboxContext });

  return sandboxContext;
}

export async function resolveSandboxContext(params: {
  config?: OpenClawConfig;
  agentId?: string;
  execOverrides?: ExecPolicyOverrides;
  requireCurrentConfig?: boolean;
  sessionKey?: string;
  skillsSnapshot?: SkillSnapshot;
  workspaceDir?: string;
}): Promise<SandboxContext | null> {
  const resolved = resolveSandboxSession(params);
  if (!resolved) {
    return null;
  }
  // Once a sandbox session is selected, every remaining step is local
  // provisioning. Preserve that owner boundary across backend, browser,
  // registry, and filesystem-bridge setup so model fallback never retries it.
  try {
    assertSandboxSessionSecretOwnerAvailable(params.config, resolved);
    return await resolveProvisionedSandboxContext(params, resolved);
  } catch (error) {
    throw toSandboxProvisioningError(error, resolved.cfg.backend);
  }
}

export async function ensureSandboxWorkspaceForSession(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxWorkspaceInfo | null> {
  const resolved = resolveSandboxSession(params);
  if (!resolved) {
    return null;
  }
  assertSandboxSessionSecretOwnerAvailable(params.config, resolved);
  const { rawSessionKey, cfg, runtime } = resolved;

  const {
    agentWorkspaceDir,
    scopeKey,
    skillsEligibility,
    skillUsagePaths,
    skillsWorkspaceDir,
    workspaceDir,
  } = await ensureSandboxWorkspaceLayout({
    cfg,
    agentId: runtime.agentId,
    rawSessionKey,
    isolationSubject: runtime.isolationSubject,
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  const containerWorkdir = resolveSandboxWorkspaceInfoWorkdir({
    cfg,
    rawSessionKey,
    scopeKey,
    workspaceDir,
    agentWorkspaceDir,
    skillsWorkspaceDir,
  });
  return {
    workspaceDir,
    ...(containerWorkdir ? { containerWorkdir } : {}),
    skillsWorkspaceDir,
    ...(skillsEligibility ? { skillsEligibility } : {}),
    ...(skillUsagePaths ? { skillUsagePaths } : {}),
    workspaceAccess: cfg.workspaceAccess,
  };
}
