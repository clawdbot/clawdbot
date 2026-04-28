import fs from "node:fs/promises";
import { inspect } from "node:util";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  AcpRuntime,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "../runtime-api.js";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "../runtime-api.js";
import { prepareAcpxCodexAuthConfig } from "./codex-auth-bridge.js";
import {
  resolveAcpxPluginConfig,
  toAcpMcpServers,
  type ResolvedAcpxPluginConfig,
} from "./config.js";

type AcpxRuntimeLike = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
  doctor?(): Promise<{
    ok: boolean;
    message: string;
    details?: string[];
  }>;
};

const ENABLE_STARTUP_PROBE_ENV = "OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE";
const ACPX_BACKEND_ID = "acpx";

type AcpxRuntimeModule = typeof import("./runtime.js");
let runtimeModulePromise: Promise<AcpxRuntimeModule> | null = null;

type AcpxRuntimeFactoryParams = {
  pluginConfig: ResolvedAcpxPluginConfig;
  logger?: PluginLogger;
};

type CreateAcpxRuntimeServiceParams = {
  pluginConfig?: unknown;
  runtimeFactory?: (params: AcpxRuntimeFactoryParams) => AcpxRuntimeLike | Promise<AcpxRuntimeLike>;
};

function loadRuntimeModule(): Promise<AcpxRuntimeModule> {
  runtimeModulePromise ??= import("./runtime.js");
  return runtimeModulePromise;
}

function createLazyDefaultRuntime(params: AcpxRuntimeFactoryParams): AcpxRuntimeLike {
  let runtime: AcpxRuntimeLike | null = null;
  let runtimePromise: Promise<AcpxRuntimeLike> | null = null;

  async function resolveRuntime(): Promise<AcpxRuntimeLike> {
    if (runtime) {
      return runtime;
    }
    runtimePromise ??= loadRuntimeModule().then((module) => {
      runtime = new module.AcpxRuntime({
        cwd: params.pluginConfig.cwd,
        sessionStore: module.createFileSessionStore({
          stateDir: params.pluginConfig.stateDir,
        }),
        agentRegistry: module.createAgentRegistry({
          overrides: params.pluginConfig.agents,
        }),
        probeAgent: params.pluginConfig.probeAgent,
        mcpServers: toAcpMcpServers(params.pluginConfig.mcpServers),
        permissionMode: params.pluginConfig.permissionMode,
        nonInteractivePermissions: params.pluginConfig.nonInteractivePermissions,
        timeoutMs:
          params.pluginConfig.timeoutSeconds != null
            ? params.pluginConfig.timeoutSeconds * 1_000
            : undefined,
      }) as AcpxRuntimeLike;
      return runtime;
    });
    return await runtimePromise;
  }

  return {
    async ensureSession(input) {
      return await (await resolveRuntime()).ensureSession(input);
    },
    async *runTurn(input) {
      yield* (await resolveRuntime()).runTurn(input);
    },
    async getCapabilities(input) {
      return (await (await resolveRuntime()).getCapabilities?.(input)) ?? { controls: [] };
    },
    async getStatus(input) {
      return (await (await resolveRuntime()).getStatus?.(input)) ?? {};
    },
    async setMode(input) {
      await (await resolveRuntime()).setMode?.(input);
    },
    async setConfigOption(input) {
      await (await resolveRuntime()).setConfigOption?.(input);
    },
    async doctor() {
      return (await (await resolveRuntime()).doctor?.()) ?? { ok: true, message: "ok" };
    },
    async prepareFreshSession(input) {
      await (await resolveRuntime()).prepareFreshSession?.(input);
    },
    async cancel(input) {
      await (await resolveRuntime()).cancel(input);
    },
    async close(input) {
      await (await resolveRuntime()).close(input);
    },
    async probeAvailability() {
      await (await resolveRuntime()).probeAvailability();
    },
    isHealthy() {
      return runtime?.isHealthy() ?? false;
    },
  };
}

function warnOnIgnoredLegacyCompatibilityConfig(params: {
  pluginConfig: ResolvedAcpxPluginConfig;
  logger?: PluginLogger;
}): void {
  const ignoredFields: string[] = [];
  if (params.pluginConfig.legacyCompatibilityConfig.queueOwnerTtlSeconds != null) {
    ignoredFields.push("queueOwnerTtlSeconds");
  }
  if (params.pluginConfig.legacyCompatibilityConfig.strictWindowsCmdWrapper === false) {
    ignoredFields.push("strictWindowsCmdWrapper=false");
  }
  if (ignoredFields.length === 0) {
    return;
  }
  params.logger?.warn(
    `embedded acpx runtime ignores legacy compatibility config: ${ignoredFields.join(", ")}`,
  );
}

function formatDoctorDetail(detail: unknown): string | null {
  if (!detail) {
    return null;
  }
  if (typeof detail === "string") {
    return detail.trim() || null;
  }
  if (detail instanceof Error) {
    return formatErrorMessage(detail);
  }
  if (typeof detail === "object") {
    try {
      return JSON.stringify(detail) ?? inspect(detail, { breakLength: Infinity, depth: 3 });
    } catch {
      return inspect(detail, { breakLength: Infinity, depth: 3 });
    }
  }
  if (
    typeof detail === "number" ||
    typeof detail === "boolean" ||
    typeof detail === "bigint" ||
    typeof detail === "symbol"
  ) {
    return detail.toString();
  }
  return inspect(detail, { breakLength: Infinity, depth: 3 });
}

function formatDoctorFailureMessage(report: { message: string; details?: unknown[] }): string {
  const detailText = report.details?.map(formatDoctorDetail).filter(Boolean).join("; ").trim();
  return detailText ? `${report.message} (${detailText})` : report.message;
}

function normalizeProbeAgent(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function resolveAllowedAgentsProbeAgent(ctx: OpenClawPluginServiceContext): string | undefined {
  for (const agent of ctx.config.acp?.allowedAgents ?? []) {
    const normalized = normalizeProbeAgent(agent);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function shouldRunStartupProbe(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENABLE_STARTUP_PROBE_ENV] === "1";
}

export function createAcpxRuntimeService(
  params: CreateAcpxRuntimeServiceParams = {},
): OpenClawPluginService {
  let runtime: AcpxRuntimeLike | null = null;
  let lifecycleRevision = 0;

  return {
    id: "acpx-runtime",
    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      if (process.env.OPENCLAW_SKIP_ACPX_RUNTIME === "1") {
        ctx.logger.info("skipping embedded acpx runtime backend (OPENCLAW_SKIP_ACPX_RUNTIME=1)");
        return;
      }

      const basePluginConfig = resolveAcpxPluginConfig({
        rawConfig: params.pluginConfig,
        workspaceDir: ctx.workspaceDir,
      });
      const effectiveBasePluginConfig: ResolvedAcpxPluginConfig = {
        ...basePluginConfig,
        probeAgent: basePluginConfig.probeAgent ?? resolveAllowedAgentsProbeAgent(ctx),
      };
      const pluginConfig = await prepareAcpxCodexAuthConfig({
        pluginConfig: effectiveBasePluginConfig,
        stateDir: ctx.stateDir,
        logger: ctx.logger,
      });
      await fs.mkdir(pluginConfig.stateDir, { recursive: true });
      warnOnIgnoredLegacyCompatibilityConfig({
        pluginConfig,
        logger: ctx.logger,
      });

      runtime = params.runtimeFactory
        ? await params.runtimeFactory({
            pluginConfig,
            logger: ctx.logger,
          })
        : createLazyDefaultRuntime({
            pluginConfig,
            logger: ctx.logger,
          });

      registerAcpRuntimeBackend({
        id: ACPX_BACKEND_ID,
        runtime,
        ...(shouldRunStartupProbe() ? { healthy: () => runtime?.isHealthy() ?? false } : {}),
      });
      ctx.logger.info(`embedded acpx runtime backend registered (cwd: ${pluginConfig.cwd})`);

      if (!shouldRunStartupProbe() || process.env.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE === "1") {
        return;
      }

      lifecycleRevision += 1;
      const currentRevision = lifecycleRevision;
      void (async () => {
        try {
          await runtime?.probeAvailability();
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          if (runtime?.isHealthy()) {
            ctx.logger.info("embedded acpx runtime backend ready");
            return;
          }
          const doctorReport = await runtime?.doctor?.();
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          ctx.logger.warn(
            `embedded acpx runtime backend probe failed: ${doctorReport ? formatDoctorFailureMessage(doctorReport) : "backend remained unhealthy after probe"}`,
          );
        } catch (err) {
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          ctx.logger.warn(`embedded acpx runtime setup failed: ${formatErrorMessage(err)}`);
        }
      })();
    },
    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      lifecycleRevision += 1;
      unregisterAcpRuntimeBackend(ACPX_BACKEND_ID);
      runtime = null;
    },
  };
}
