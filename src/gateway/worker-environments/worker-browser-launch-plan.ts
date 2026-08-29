import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { resolveManifestActivationPluginIds } from "../../plugins/activation-planner.js";
import type { WorkerDesktopEndpoint } from "../../plugins/types.js";
import type { WorkerBrowserLaunchDescriptor } from "../../worker/launch-descriptor.js";
import type { WorkerToolAuthority } from "../../worker/tool-authority.js";
import { resolveWorkerToolAuthority } from "./worker-tool-authority.js";

/** Plans the optional Browser surface from persisted provider metadata and normal tool policy. */
export function resolveWorkerBrowserLaunchPlan(params: {
  desktop: WorkerDesktopEndpoint | null;
  modelRef: { provider: string; model: string };
  turn: SessionPlacementTurnParams;
  githubPublicationAvailable?: boolean;
  portalAvailable?: boolean;
}): {
  browser?: WorkerBrowserLaunchDescriptor;
  toolAuthority: WorkerToolAuthority;
} {
  const browserApp = params.desktop?.apps?.find((app) => app.id === "browser");
  const browserAvailable =
    browserApp !== undefined &&
    params.turn.config?.browser?.enabled !== false &&
    resolveManifestActivationPluginIds({
      trigger: { kind: "capability", capability: "tool" },
      config: params.turn.config,
      onlyPluginIds: ["browser"],
    }).includes("browser");
  const toolAuthority = resolveWorkerToolAuthority({
    modelRef: params.modelRef,
    turn: params.turn,
    githubPublicationAvailable: params.githubPublicationAvailable,
    portalAvailable: params.portalAvailable,
    ...(browserAvailable ? { availableOptionalToolNames: ["browser"] } : {}),
  });
  return {
    toolAuthority,
    ...(browserApp && toolAuthority.allowedToolNames.includes("browser")
      ? {
          browser: {
            cdpUrl: `http://127.0.0.1:${browserApp.cdpPort}`,
            launcherPath: browserApp.executablePath,
          },
        }
      : {}),
  };
}
