import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import JSON5 from "json5";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { runCommandBuffered } from "../process/exec.js";
import { resolveUserPath } from "./home-dir.js";
import { tryListenOnPort } from "./ports-probe.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { SUPERVISOR_HINT_ENV_VARS } from "./supervisor-markers.js";
import { resolveUpdateCandidateStatePath } from "./update-candidate-paths.js";
import { UpdateCandidateStateSnapshotSchema } from "./update-candidate-state.js";
import {
  CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
  UPDATE_RUN_ID_ENV,
} from "./update-control-plane-sentinel.js";
import {
  POST_CORE_UPDATE_ENV,
  POST_CORE_UPDATE_CHANNEL_ENV,
  POST_CORE_UPDATE_RESULT_PATH_ENV,
  POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV,
  POST_CORE_UPDATE_STARTED_AT_ENV,
  POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV,
  POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV,
} from "./update-post-core-context.js";
import { buildUpdateDoctorEnv } from "./update-runner-doctor.js";

export type UpdateCandidateRehearsal = {
  sourceConfig: OpenClawConfig;
  sourceConfigHash: string | null | undefined;
  stateDir: string;
  configPath: string;
  workspaceDir: string;
  env: NodeJS.ProcessEnv;
  port: number;
  changedConfigKeys: () => Promise<string[]>;
  cleanup: () => Promise<void>;
};

function isolatedConfig(
  config: OpenClawConfig,
  sourceRoot: string,
  stateDir: string,
  port: number,
  sourceEnv: NodeJS.ProcessEnv,
  pluginPaths: Record<string, string>,
): OpenClawConfig {
  const copied = structuredClone(config);
  const projectPluginPath = (value: string) => {
    const projected = pluginPaths[resolveUserPath(value, sourceEnv)];
    if (!projected) {
      throw new Error("Plugin locator was not included in the candidate snapshot");
    }
    return projected;
  };
  for (const record of Object.values(copied.plugins?.installs ?? {})) {
    if (record.source === "path" && record.sourcePath) {
      record.sourcePath = projectPluginPath(record.sourcePath);
    }
    if (record.installPath) {
      record.installPath = projectPluginPath(record.installPath);
    }
  }
  if (copied.plugins?.load?.paths) {
    copied.plugins.load.paths = copied.plugins.load.paths.map(projectPluginPath);
  }
  const workspace = path.join(stateDir, "workspace");
  const entries =
    copied.agents?.entries ??
    Object.fromEntries((copied.agents?.list ?? []).map(({ id, ...agent }) => [id, agent]));
  copied.agents = {
    ...copied.agents,
    defaults: { ...copied.agents?.defaults, workspace, cwd: workspace, heartbeat: { every: "0m" } },
    entries: Object.fromEntries(
      Object.entries(entries).map(([id, agent]) => [
        id,
        {
          ...agent,
          workspace: path.join(workspace, id),
          cwd: path.join(workspace, id),
          agentDir: agent.agentDir
            ? resolveUpdateCandidateStatePath(
                sourceRoot,
                stateDir,
                resolveUserPath(agent.agentDir, sourceEnv),
              )
            : path.join(stateDir, "agents", id, "agent"),
          heartbeat: { every: "0m" },
        },
      ]),
    ),
  };
  delete copied.agents.list;
  // Copy effective config, never its include graph or ambient shell overrides.
  delete copied.env;
  delete copied.diagnostics;
  delete copied.session?.store;
  copied.logging = { ...copied.logging, file: path.join(stateDir, "canary.log") };
  copied.gateway = {
    ...copied.gateway,
    mode: "local",
    bind: "loopback",
    port,
    auth: { mode: "token", token: randomUUID() },
    tls: { enabled: false },
    tailscale: { mode: "off" },
    controlUi: { enabled: false },
  };
  copied.cron = { ...copied.cron, enabled: false, triggers: { enabled: false } };
  copied.hooks = { enabled: false, internal: { enabled: false } };
  copied.transcripts = { enabled: false, autoStart: [] };
  copied.discovery = { mdns: { mode: "off" } };
  return copied;
}

/** One disposable generation, shared by candidate diagnostics and every turn of a repair run. */
export async function prepareUpdateCandidateRehearsal(params: {
  config: OpenClawConfig;
  sourceConfigHash?: string | null;
  candidateRoot: string;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  nodeRunner?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<UpdateCandidateRehearsal> {
  const deadline = Date.now() + (params.timeoutMs ?? 300_000);
  const remaining = () => {
    params.signal?.throwIfAborted();
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) {
      throw new Error("Candidate snapshot deadline exceeded");
    }
    return milliseconds;
  };
  const tempDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-canary-")),
  );
  const sourceEnv = params.env ?? process.env;
  const configPath = path.join(tempDir, "openclaw.json");
  const workspaceDir = path.join(tempDir, "workspace");
  const copiedAgentDir = (directory: string | undefined) =>
    directory?.trim()
      ? resolveUpdateCandidateStatePath(
          path.resolve(params.stateDir),
          tempDir,
          resolveUserPath(directory, sourceEnv),
        )
      : undefined;
  const env: NodeJS.ProcessEnv = {
    ...sourceEnv,
    HOME: tempDir,
    USERPROFILE: tempDir,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
    XDG_CONFIG_HOME: path.join(tempDir, "config"),
    XDG_CACHE_HOME: path.join(tempDir, "cache"),
    XDG_DATA_HOME: path.join(tempDir, "data"),
    XDG_STATE_HOME: path.join(tempDir, "state"),
    OPENCLAW_HOME: tempDir,
    OPENCLAW_STATE_DIR: tempDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_WORKSPACE_DIR: workspaceDir,
    OPENCLAW_AGENT_DIR: copiedAgentDir(sourceEnv.OPENCLAW_AGENT_DIR),
    PI_CODING_AGENT_DIR: copiedAgentDir(sourceEnv.PI_CODING_AGENT_DIR),
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
    OPENCLAW_NO_AUTO_UPDATE: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_GATEWAY_SERVICE_PID: undefined,
    OPENCLAW_GATEWAY_PORT: undefined,
    OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
    OPENCLAW_GATEWAY_TOKEN: undefined,
    OPENCLAW_GATEWAY_PASSWORD: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: undefined,
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    ...buildUpdateDoctorEnv({
      allowGatewayServiceRepair: false,
      allowGatewayActivation: false,
      serviceRepairPolicy: "external",
      deferConfiguredPluginInstallRepair: true,
    }),
  };
  // These selectors name the serving owner's service or files outside copied
  // state. Rehearsal must never inherit its update continuation authority.
  for (const key of [
    ...SUPERVISOR_HINT_ENV_VARS,
    CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
    UPDATE_RUN_ID_ENV,
    "OPENCLAW_UPDATE_RUN_HANDOFF",
    POST_CORE_UPDATE_ENV,
    POST_CORE_UPDATE_CHANNEL_ENV,
    POST_CORE_UPDATE_RESULT_PATH_ENV,
    POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV,
    POST_CORE_UPDATE_STARTED_AT_ENV,
    POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV,
    POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV,
  ]) {
    delete env[key];
  }
  try {
    const snapshot = await runCommandBuffered(
      [
        params.nodeRunner ?? process.execPath,
        ...resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState),
          params.nodeRunner,
        ),
      ],
      {
        input: JSON.stringify({
          mode: "snapshot",
          stateDir: params.stateDir,
          config: params.config,
          targetStateDir: tempDir,
          candidateRoot: params.candidateRoot,
          env: {
            HOME: sourceEnv.HOME,
            OPENCLAW_HOME: sourceEnv.OPENCLAW_HOME,
            USERPROFILE: sourceEnv.USERPROFILE,
            OPENCLAW_AGENT_DIR: sourceEnv.OPENCLAW_AGENT_DIR,
            PI_CODING_AGENT_DIR: sourceEnv.PI_CODING_AGENT_DIR,
          },
        }),
        baseEnv: env,
        timeoutMs: remaining(),
        signal: params.signal,
        killGraceMs: 500,
        maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
      },
    );
    if (snapshot.code !== 0) {
      throw new Error(
        `Candidate state snapshot failed (${snapshot.termination}): ${redactSupportString(snapshot.stderr.toString("utf8"), { env: sourceEnv, stateDir: params.stateDir }, { maxLength: 20_000 })}`,
      );
    }
    const { pluginPaths } = UpdateCandidateStateSnapshotSchema.parse(
      JSON.parse(snapshot.stdout.toString("utf8")),
    );
    const port = await tryListenOnPort({
      port: 0,
      host: "127.0.0.1",
      signal: AbortSignal.timeout(remaining()),
    });
    const serialized = JSON.stringify(
      isolatedConfig(
        params.config,
        path.resolve(params.stateDir),
        tempDir,
        port,
        sourceEnv,
        pluginPaths,
      ),
    );
    const baseline: Record<string, unknown> = JSON.parse(serialized);
    await fs.writeFile(configPath, serialized, { mode: 0o600 });
    await fs.mkdir(workspaceDir, { recursive: true, mode: 0o700 });
    return {
      sourceConfig: params.config,
      sourceConfigHash: params.sourceConfigHash,
      stateDir: tempDir,
      configPath,
      workspaceDir,
      env,
      port,
      changedConfigKeys: async () => {
        const current: unknown = JSON5.parse(await fs.readFile(configPath, "utf8"));
        if (!isRecord(current)) {
          throw new Error("Rehearsal config is not an object.");
        }
        // Compare against the same live config projection: private paths, the
        // canary token and disabled background services are isolation, not repairs.
        return [...new Set([...Object.keys(baseline), ...Object.keys(current)])]
          .filter((key) => !isDeepStrictEqual(baseline[key], current[key]))
          .toSorted();
      },
      cleanup: () => fs.rm(tempDir, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}
