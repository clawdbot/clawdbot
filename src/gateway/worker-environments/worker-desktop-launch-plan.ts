import { WORKER_COMPUTER_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-computer.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { resolveManifestActivationPluginIds } from "../../plugins/activation-planner.js";
import type { WorkerDesktopEndpoint } from "../../plugins/types.js";
import type {
  WorkerBrowserLaunchDescriptor,
  WorkerComputerLaunchDescriptor,
} from "../../worker/launch-descriptor.js";
import type {
  WorkerToolAuthority,
  WorkerOptionalLocalToolName,
} from "../../worker/tool-authority.js";
import type { PreparedWorkerComputer } from "./computer-transport.js";
import { resolveWorkerToolAuthority } from "./worker-tool-authority.js";

/** Plans desktop tools from prepared provider capabilities and normal tool policy. */
export async function prepareWorkerDesktopLaunchPlan(params: {
  desktop: WorkerDesktopEndpoint | null;
  protocolFeatures: readonly string[];
  prepareComputer(): Promise<PreparedWorkerComputer | undefined> | undefined;
  modelRef: { provider: string; model: string };
  turn: SessionPlacementTurnParams;
  portalAvailable?: boolean;
}): Promise<{
  browser?: WorkerBrowserLaunchDescriptor;
  computer?: WorkerComputerLaunchDescriptor;
  toolAuthority: WorkerToolAuthority;
  preparedComputer?: PreparedWorkerComputer;
}> {
  const computerSupported =
    params.turn.modelHasVision !== false &&
    params.protocolFeatures.includes(WORKER_COMPUTER_PROTOCOL_FEATURE);
  const preparedComputer = computerSupported ? await params.prepareComputer() : undefined;
  const computer = preparedComputer?.descriptor;
  const browserApp = params.desktop?.apps?.find((app) => app.id === "browser");
  const browserAvailable =
    browserApp !== undefined &&
    params.turn.config?.browser?.enabled !== false &&
    resolveManifestActivationPluginIds({
      trigger: { kind: "capability", capability: "tool" },
      config: params.turn.config,
      onlyPluginIds: ["browser"],
    }).includes("browser");
  const availableOptionalToolNames: WorkerOptionalLocalToolName[] = [];
  if (browserAvailable) {
    availableOptionalToolNames.push("browser");
  }
  if (computer) {
    availableOptionalToolNames.push("computer");
  }
  const toolAuthority = resolveWorkerToolAuthority({
    modelRef: params.modelRef,
    turn: params.turn,
    portalAvailable: params.portalAvailable,
    availableOptionalToolNames,
  });
  return {
    toolAuthority,
    ...(computer && toolAuthority.allowedToolNames.includes("computer")
      ? { computer, preparedComputer }
      : {}),
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
