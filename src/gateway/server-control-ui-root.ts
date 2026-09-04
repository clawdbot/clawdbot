// Gateway-owned Control UI root lifecycle and background asset preparation.
import fs from "node:fs";
import path from "node:path";
import {
  ensureControlUiAssetsBuilt,
  isPackageProvenControlUiRootSync,
  isControlUiStartupAssetsReady,
  resolveControlUiRootOverrideSync,
  resolveControlUiRootSync,
} from "../infra/control-ui-assets.js";
import type { RuntimeEnv } from "../runtime.js";
import { createControlUiAssetRetention } from "./control-ui-asset-retention.js";
import { CONTROL_UI_BUILD_ID_ATTRIBUTE } from "./control-ui-root-assets.js";
import type { ControlUiRootState } from "./control-ui.js";

type GatewayControlUiRootParams = {
  controlUiRootOverride?: string;
  controlUiEnabled: boolean;
  gatewayRuntime: RuntimeEnv;
  log: { warn: (message: string) => void };
};

export type GatewayControlUiRootLifecycle = {
  state: ControlUiRootState | undefined;
  start: (isStopped: () => boolean, signal: AbortSignal) => Promise<void>;
  stop: () => Promise<void>;
};

function resolveAutoRoot(): string | null {
  return resolveControlUiRootSync({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
}

function createResolvedRootState(root: string, configured = false): ControlUiRootState {
  const bundled =
    !configured &&
    isPackageProvenControlUiRootSync(root, {
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    });
  return bundled
    ? {
        kind: "bundled",
        path: root,
        realPath: fs.realpathSync(root),
        // Snapshot build metadata at the root lifecycle boundary, never per request.
        publicAssetBuildId: new RegExp(
          `${CONTROL_UI_BUILD_ID_ATTRIBUTE}="([a-zA-Z0-9._-]{1,161})"`,
        ).exec(fs.readFileSync(path.join(root, "index.html"), "utf8"))?.[1],
        retainedAssets: createControlUiAssetRetention(root),
      }
    : {
        kind: "resolved",
        path: root,
        realPath: fs.realpathSync(root),
      };
}

function prepareResolvedRootState(params: {
  root: string;
  configured?: boolean;
  log: GatewayControlUiRootParams["log"];
}): ControlUiRootState {
  try {
    return createResolvedRootState(params.root, params.configured);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `Control UI assets are unavailable at ${params.root}: ${detail}`;
    params.log.warn(`gateway: ${message}`);
    return params.configured
      ? { kind: "invalid", path: path.resolve(params.root) }
      : { kind: "failed" };
  }
}

/** Prepare the stable root reference shared by every HTTP listener. */
export function createGatewayControlUiRootLifecycle(
  params: GatewayControlUiRootParams,
): GatewayControlUiRootLifecycle {
  let state: ControlUiRootState | undefined;
  if (params.controlUiRootOverride) {
    const resolvedOverride = resolveControlUiRootOverrideSync(params.controlUiRootOverride);
    const resolvedOverridePath = path.resolve(params.controlUiRootOverride);
    if (!resolvedOverride) {
      params.log.warn(`gateway: controlUi.root not found at ${resolvedOverridePath}`);
      state = { kind: "invalid", path: resolvedOverridePath };
    } else {
      state = prepareResolvedRootState({
        root: resolvedOverride,
        configured: true,
        log: params.log,
      });
    }
  } else if (params.controlUiEnabled) {
    const resolvedRoot = resolveAutoRoot();
    state =
      resolvedRoot && isControlUiStartupAssetsReady(resolvedRoot)
        ? prepareResolvedRootState({ root: resolvedRoot, log: params.log })
        : { kind: "preparing" };
  }

  let buildPromise: Promise<void> | undefined;
  let retentionPromise: Promise<void> | undefined;
  const prepareRetention = (isStopped: () => boolean, signal: AbortSignal): Promise<void> => {
    if (state?.kind !== "bundled" || !state.retainedAssets) {
      return Promise.resolve();
    }
    retentionPromise ??= state.retainedAssets
      .prepare({ isCancelled: isStopped, signal })
      .catch((error: unknown) => {
        if (isStopped() || signal.aborted) {
          return;
        }
        const detail = error instanceof Error ? error.message : String(error);
        params.log.warn(`gateway: Control UI asset retention failed: ${detail}`);
      });
    return retentionPromise;
  };
  const start = (isStopped: () => boolean, signal: AbortSignal): Promise<void> => {
    if (isStopped() || signal.aborted) {
      return Promise.resolve();
    }
    if (state?.kind !== "preparing") {
      return prepareRetention(isStopped, signal);
    }
    const preparingState = state;
    buildPromise ??= (async () => {
      try {
        const result = await ensureControlUiAssetsBuilt(params.gatewayRuntime, { signal });
        if (isStopped() || signal.aborted) {
          return;
        }
        if (!result.ok) {
          const message = result.message ?? "Control UI assets could not be built.";
          Object.assign(preparingState, { kind: "failed" });
          params.log.warn(`gateway: ${message}`);
          return;
        }

        const resolvedRoot = resolveAutoRoot();
        if (!resolvedRoot || !isControlUiStartupAssetsReady(resolvedRoot)) {
          const message = resolvedRoot
            ? `Control UI assets at ${resolvedRoot} remain incomplete.`
            : "Control UI build completed, but its assets are still unavailable.";
          Object.assign(preparingState, { kind: "failed" });
          params.log.warn(
            `gateway: ${message} Run \`openclaw doctor --fix\` or reinstall OpenClaw.`,
          );
          return;
        }
        // Listeners retain this object from before bind; replacing it would strand
        // their routes in the preparing state after a successful background build.
        Object.assign(preparingState, createResolvedRootState(resolvedRoot));
        await prepareRetention(isStopped, signal);
      } catch (error) {
        if (isStopped() || signal.aborted) {
          return;
        }
        const detail = error instanceof Error ? error.message : String(error);
        const message = `Control UI assets build failed: ${detail}`;
        Object.assign(preparingState, { kind: "failed" });
        params.log.warn(`gateway: ${message}`);
      }
    })();
    return buildPromise;
  };

  return {
    state,
    start,
    stop: async () => {
      await Promise.all([buildPromise, retentionPromise]);
    },
  };
}
