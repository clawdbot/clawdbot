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
import { runOutsideGatewayRootWorkAdmission } from "../process/gateway-work-admission.js";
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
  state: ControlUiRootState;
  setEnabled: (enabled: boolean) => void;
  start: () => Promise<void>;
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
  let state: ControlUiRootState = { kind: "preparing" };
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

  let enabled = params.controlUiEnabled;
  let stopped = false;
  let preparation: { controller: AbortController; promise: Promise<void> } | undefined;
  const prepare = async (signal: AbortSignal): Promise<void> => {
    const isStopped = () => stopped || signal.aborted;
    if (isStopped()) {
      return;
    }
    try {
      if (state.kind === "preparing") {
        // Initially disabled gateways discover assets only when enabled. Reuse a
        // finished build after cancellation without reviving its retired preparer.
        let resolvedRoot = resolveAutoRoot();
        if (!resolvedRoot || !isControlUiStartupAssetsReady(resolvedRoot)) {
          const result = await ensureControlUiAssetsBuilt(params.gatewayRuntime, { signal });
          if (isStopped()) {
            return;
          }
          if (!result.ok) {
            Object.assign(state, { kind: "failed" });
            params.log.warn(
              `gateway: ${result.message ?? "Control UI assets could not be built."}`,
            );
            return;
          }
          resolvedRoot = resolveAutoRoot();
        }
        if (!resolvedRoot || !isControlUiStartupAssetsReady(resolvedRoot)) {
          const message = resolvedRoot
            ? `Control UI assets at ${resolvedRoot} remain incomplete.`
            : "Control UI build completed, but its assets are still unavailable.";
          Object.assign(state, { kind: "failed" });
          params.log.warn(
            `gateway: ${message} Run \`openclaw doctor --fix\` or reinstall OpenClaw.`,
          );
          return;
        }
        // Listeners retain this object from before bind; replacing it would strand
        // their routes in the preparing state after a successful background build.
        Object.assign(state, createResolvedRootState(resolvedRoot));
      }
    } catch (error) {
      if (!isStopped()) {
        Object.assign(state, { kind: "failed" });
        const detail = error instanceof Error ? error.message : String(error);
        params.log.warn(`gateway: Control UI assets build failed: ${detail}`);
      }
      return;
    }
    if (state.kind === "bundled") {
      await state.retainedAssets
        ?.prepare({ isCancelled: isStopped, signal })
        .catch((error: unknown) => {
          if (isStopped()) {
            return;
          }
          const detail = error instanceof Error ? error.message : String(error);
          params.log.warn(`gateway: Control UI asset retention failed: ${detail}`);
        });
    }
  };
  const start = (): Promise<void> => {
    if (!enabled || stopped) {
      return Promise.resolve();
    }
    if (preparation) {
      return preparation.controller.signal.aborted
        ? preparation.promise.then(start)
        : preparation.promise;
    }
    const controller = new AbortController();
    const promise = runOutsideGatewayRootWorkAdmission(() =>
      Promise.resolve().then(() => prepare(controller.signal)),
    ).finally(() => {
      preparation = undefined;
    });
    preparation = { controller, promise };
    return promise;
  };

  return {
    state,
    start,
    setEnabled: (nextEnabled) => {
      if (stopped || enabled === nextEnabled) {
        return;
      }
      enabled = nextEnabled;
      if (enabled) {
        if (state.kind === "failed") {
          Object.assign(state, { kind: "preparing" });
        }
        void start();
      } else {
        preparation?.controller.abort();
      }
    },
    stop: async () => {
      stopped = true;
      preparation?.controller.abort();
      await preparation?.promise;
    },
  };
}
