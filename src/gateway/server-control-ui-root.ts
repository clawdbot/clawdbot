// Gateway Control UI root resolver.
// Finds configured, bundled, or source-built UI assets during startup.
import path from "node:path";
import {
  ensureControlUiAssetsBuilt,
  isPackageProvenControlUiRootSync,
  resolveControlUiRootOverrideSync,
  resolveControlUiRootSync,
} from "../infra/control-ui-assets.js";
import type { RuntimeEnv } from "../runtime.js";
import type { ControlUiRootState } from "./control-ui.js";

function startControlUiAssetsBuild(params: {
  gatewayRuntime: RuntimeEnv;
  log: { warn: (message: string) => void };
}): void {
  void ensureControlUiAssetsBuilt(params.gatewayRuntime)
    .then((result) => {
      if (!result.ok && result.message) {
        params.log.warn(`gateway: ${result.message}`);
      }
    })
    .catch((error: unknown) => {
      params.log.warn(
        `gateway: Control UI assets build failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}

/** Resolves the Control UI asset root state for gateway startup. */
export async function resolveGatewayControlUiRootState(params: {
  controlUiRootOverride?: string;
  controlUiEnabled: boolean;
  gatewayRuntime: RuntimeEnv;
  log: { warn: (message: string) => void };
}): Promise<ControlUiRootState | undefined> {
  if (params.controlUiRootOverride) {
    const resolvedOverride = resolveControlUiRootOverrideSync(params.controlUiRootOverride);
    const resolvedOverridePath = path.resolve(params.controlUiRootOverride);
    if (!resolvedOverride) {
      params.log.warn(`gateway: controlUi.root not found at ${resolvedOverridePath}`);
    }
    return resolvedOverride
      ? { kind: "resolved", path: resolvedOverride }
      : { kind: "invalid", path: resolvedOverridePath };
  }

  if (!params.controlUiEnabled) {
    return undefined;
  }

  const resolveRoot = () =>
    resolveControlUiRootSync({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    });

  const resolvedRoot = resolveRoot();
  if (!resolvedRoot) {
    // Source checkouts may need to build Control UI assets on demand; startup
    // continues and the route can become available after the build completes.
    startControlUiAssetsBuild({
      gatewayRuntime: params.gatewayRuntime,
      log: params.log,
    });
    return undefined;
  }

  return {
    kind: isPackageProvenControlUiRootSync(resolvedRoot, {
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    })
      ? "bundled"
      : "resolved",
    path: resolvedRoot,
  };
}
