import { execFile } from "node:child_process";
import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import { listAgentIds, resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import { resolveEffectiveAgentRuntime } from "openclaw/plugin-sdk/command-auth-native";
import type { HealthCheck, HealthFinding } from "openclaw/plugin-sdk/health";
import {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexAppServerStartOptionsForAgent,
} from "./app-server/config.js";
import {
  isManagedCodexDesktopCommand,
  resolveManagedCodexAppServerStartOptions,
  resolveManagedCodexNativeCommand,
} from "./app-server/managed-binary.js";
import { CODEX_APP_SERVER_VERSION } from "./app-server/version.js";

export const CODEX_MANAGED_APP_SERVER_CHECK_ID = "codex/managed-app-server";
const CODEX_VERSION_TIMEOUT_MS = 5_000;
const CODEX_VERSION_MAX_BUFFER_BYTES = 64 * 1024;

type VersionCommandResult = {
  stdout: string;
  stderr: string;
};

type CodexManagedDoctorDependencies = {
  resolveAgentStartOptions?: typeof resolveCodexAppServerStartOptionsForAgent;
  resolveStartOptions?: typeof resolveManagedCodexAppServerStartOptions;
  isDesktopCommand?: typeof isManagedCodexDesktopCommand;
  resolveNativeCommand?: typeof resolveManagedCodexNativeCommand;
  runVersionCommand?: (command: string) => Promise<VersionCommandResult>;
};

type CodexManagedDoctorRegistrationHost = {
  readonly getHealthCheck: (id: string) => HealthCheck | undefined;
  readonly registerHealthCheck: (check: HealthCheck) => void;
  readonly pluginRoot: string;
};

function managedCodexFinding(params: {
  message: string;
  path?: string;
  requirement?: string;
  fixHint?: string;
}): HealthFinding {
  return {
    checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
    severity: "error",
    source: "codex",
    message: params.message,
    ...(params.path ? { path: params.path } : {}),
    ...(params.requirement ? { requirement: params.requirement } : {}),
    ...(params.fixHint ? { fixHint: params.fixHint } : {}),
  };
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseCodexVersion(output: string): string | undefined {
  return /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s|$)/u.exec(
    output,
  )?.[1];
}

function runVersionCommand(command: string): Promise<VersionCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      ["--version"],
      {
        encoding: "utf8",
        maxBuffer: CODEX_VERSION_MAX_BUFFER_BYTES,
        timeout: CODEX_VERSION_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(readErrorMessage(error), { cause: error }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function createCodexManagedAppServerHealthCheck(params: {
  pluginRoot: string;
  deps?: CodexManagedDoctorDependencies;
}): HealthCheck & { readonly defaultEnabled: false } {
  const resolveStartOptions =
    params.deps?.resolveStartOptions ?? resolveManagedCodexAppServerStartOptions;
  const resolveAgentStartOptions =
    params.deps?.resolveAgentStartOptions ?? resolveCodexAppServerStartOptionsForAgent;
  const isDesktopCommand = params.deps?.isDesktopCommand ?? isManagedCodexDesktopCommand;
  const resolveNativeCommand =
    params.deps?.resolveNativeCommand ?? resolveManagedCodexNativeCommand;
  const executeVersion = params.deps?.runVersionCommand ?? runVersionCommand;

  return {
    id: CODEX_MANAGED_APP_SERVER_CHECK_ID,
    kind: "plugin",
    description: "Verify the selected managed Codex app-server binary and pinned version.",
    source: "codex",
    defaultEnabled: false,
    async detect(ctx) {
      const pluginConfig = ctx.cfg.plugins?.entries?.codex?.config;
      const start = resolveCodexAppServerRuntimeOptions({
        pluginConfig,
        env: ctx.env ?? process.env,
      }).start;
      if (start.transport !== "stdio" || start.commandSource !== "managed") {
        return [];
      }

      const env = ctx.env ?? process.env;
      let resolved;
      for (const agentId of listAgentIds(ctx.cfg)) {
        const model = resolveDefaultModelForAgent({ cfg: ctx.cfg, agentId });
        if (
          resolveEffectiveAgentRuntime({
            cfg: ctx.cfg,
            provider: model.provider,
            modelId: model.model,
            agentId,
          }) !== "codex"
        ) {
          continue;
        }
        const agentStart = resolveAgentStartOptions({
          startOptions: start,
          agentDir: resolveAgentDir(ctx.cfg, agentId, env),
          env,
        });
        try {
          resolved = await resolveStartOptions(agentStart, { pluginRoot: params.pluginRoot });
        } catch (error) {
          return [
            managedCodexFinding({
              message: `Managed Codex app-server could not be resolved: ${readErrorMessage(error)}`,
              path: params.pluginRoot,
              requirement: `an executable Codex ${CODEX_APP_SERVER_VERSION} managed artifact`,
              fixHint:
                "Reinstall the staged OpenClaw package with its @openai/codex platform dependency, then rerun the candidate check.",
            }),
          ];
        }
        if (!isDesktopCommand(resolved.command)) {
          break;
        }
        resolved = undefined;
      }

      if (!resolved) {
        return [];
      }

      const nativeCommand = resolveNativeCommand(resolved.command);
      if (!nativeCommand) {
        return [
          managedCodexFinding({
            message: "Managed Codex app-server resolved a launcher without a native artifact.",
            path: resolved.command,
            requirement: `the platform-native Codex ${CODEX_APP_SERVER_VERSION} executable`,
            fixHint:
              "Reinstall the staged OpenClaw package with the matching @openai/codex platform package, then rerun the candidate check.",
          }),
        ];
      }

      let output: VersionCommandResult;
      try {
        output = await executeVersion(nativeCommand);
      } catch (error) {
        return [
          managedCodexFinding({
            message: `Managed Codex app-server version check failed: ${readErrorMessage(error)}`,
            path: nativeCommand,
            requirement: `Codex ${CODEX_APP_SERVER_VERSION} must report its version within ${CODEX_VERSION_TIMEOUT_MS} ms`,
            fixHint:
              "Repair or reinstall the staged OpenClaw package, then rerun the candidate check before cutover.",
          }),
        ];
      }

      const detectedVersion = parseCodexVersion(`${output.stdout}\n${output.stderr}`);
      if (detectedVersion !== CODEX_APP_SERVER_VERSION) {
        return [
          managedCodexFinding({
            message: detectedVersion
              ? `Managed Codex app-server version mismatch: expected ${CODEX_APP_SERVER_VERSION}, detected ${detectedVersion}.`
              : `Managed Codex app-server did not report a parseable version; expected ${CODEX_APP_SERVER_VERSION}.`,
            path: nativeCommand,
            requirement: `the exact OpenClaw-pinned Codex version ${CODEX_APP_SERVER_VERSION}`,
            fixHint:
              "Reinstall the staged OpenClaw package so its managed @openai/codex dependency matches the pinned version, then rerun the candidate check.",
          }),
        ];
      }
      return [];
    },
  };
}

export function registerCodexManagedAppServerDoctorChecks(
  host: CodexManagedDoctorRegistrationHost,
  deps?: CodexManagedDoctorDependencies,
): void {
  // Lookup and registration must use the same host registry across artifact loaders.
  if (host.getHealthCheck(CODEX_MANAGED_APP_SERVER_CHECK_ID)) {
    return;
  }
  host.registerHealthCheck(
    createCodexManagedAppServerHealthCheck({ pluginRoot: host.pluginRoot, deps }),
  );
}
