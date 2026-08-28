/** Core-private adapter for the bundled Browser plugin's attached worker runtime. */
import { execFile } from "node:child_process";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { loadBundledPluginPublicSurfaceModuleSyncCore } from "../plugin-sdk/facade-loader.js";
import type { WorkerBrowserLaunchDescriptor } from "./launch-descriptor.js";

const WORKER_BROWSER_LAUNCH_TIMEOUT_MS = 30_000;
const WORKER_BROWSER_LAUNCH_OUTPUT_LIMIT_BYTES = 64 * 1024;

export type WorkerBrowserRuntime = {
  createAttachedBrowserToolRuntime: (params: {
    cdpUrl: string;
    ensureAttachTarget: () => Promise<void>;
    agentSessionKey?: string;
    agentDir?: string;
    workspaceDir: string;
  }) => Promise<{
    tool: AnyAgentTool;
    dispose: () => Promise<void>;
  }>;
};

type WorkerBrowserToolRuntime = {
  tool: AnyAgentTool;
  dispose: () => Promise<void>;
};

type CreateWorkerBrowserToolRuntimeParams = {
  descriptor: WorkerBrowserLaunchDescriptor;
  sessionKey: string;
  stateDir: string;
  workspaceDir: string;
  runtime?: WorkerBrowserRuntime;
};

function runWorkerBrowserLauncher(launcherPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      launcherPath,
      [],
      {
        timeout: WORKER_BROWSER_LAUNCH_TIMEOUT_MS,
        maxBuffer: WORKER_BROWSER_LAUNCH_OUTPUT_LIMIT_BYTES,
        windowsHide: true,
      },
      (error) => {
        if (error) {
          reject(
            new Error(`Worker Browser launcher failed: ${error.message}`, {
              cause: error,
            }),
          );
          return;
        }
        resolve();
      },
    );
  });
}

/** Materialize the exact bundled Browser runtime; no descriptor-controlled plugin path is used. */
export async function createWorkerBrowserToolRuntime(
  params: CreateWorkerBrowserToolRuntimeParams,
): Promise<WorkerBrowserToolRuntime> {
  const browserRuntime =
    params.runtime ??
    loadBundledPluginPublicSurfaceModuleSyncCore<WorkerBrowserRuntime>({
      dirName: "browser",
      artifactBasename: "runtime-api.js",
      trackedPluginId: "browser",
    });
  return await browserRuntime.createAttachedBrowserToolRuntime({
    cdpUrl: params.descriptor.cdpUrl,
    ensureAttachTarget: async () => await runWorkerBrowserLauncher(params.descriptor.launcherPath),
    agentSessionKey: params.sessionKey,
    agentDir: params.stateDir,
    workspaceDir: params.workspaceDir,
  });
}
