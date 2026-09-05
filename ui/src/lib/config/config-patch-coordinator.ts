import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import {
  adoptConfigPatchAck,
  patchConfig,
  type ConfigPatchBuildResult,
} from "./config-gateway-operations.ts";
import {
  currentConfigConnectionEpoch,
  isCurrentConfigConnection,
  nextRequestVersion,
  type RuntimeConfigState,
} from "./config-state-model.ts";

export function createConfigPatchCoordinator(options: {
  state: RuntimeConfigState;
  dispatch: (task: () => Promise<boolean>) => Promise<boolean>;
  refresh: () => Promise<boolean>;
  resetConfigLoad: () => void;
  cancelAppliedRefresh: () => void;
  reconcileAppliedRefresh: () => void;
  reconcileDraft: () => void;
  scheduleAutoSave: () => void;
}) {
  const { state } = options;
  // Recovery belongs to the rejected operation, not the unchanged whole-form
  // draft. The write owner clears it when that connection or intent is retired.
  let failedPatch: (() => ConfigPatchBuildResult) | null = null;
  const queue = (resolveOptions: () => ConfigPatchBuildResult): Promise<boolean> => {
    options.cancelAppliedRefresh();
    return options
      .dispatch(async () => {
        // A drained autosave can start its own refresh while this patch waits.
        options.cancelAppliedRefresh();
        const client = state.client;
        const epoch = currentConfigConnectionEpoch(state);
        try {
          const resolved = resolveOptions();
          if ("error" in resolved) {
            state.lastError = resolved.error;
            state.configAutoSaveStatus = "error";
            failedPatch = resolveOptions;
            return false;
          }
          if (!client || !state.configSnapshot || resolved.options.canDispatch?.() === false) {
            return false;
          }
          const patched = await patchConfig(
            state,
            resolved.options,
            async (ack, snapshotAtDispatch) => {
              // The ack is newer than every config.get that began before it.
              // Invalidate those loads before publishing the acknowledged revision.
              options.resetConfigLoad();
              nextRequestVersion(state, "config");
              state.configLoading = false;
              if (asConfigRecord(ack.config)) {
                adoptConfigPatchAck(state, ack, snapshotAtDispatch);
                return;
              }
              // A hash-only acknowledgement needs an authoritative document before
              // its revision can become the base of another write.
              if (!(await options.refresh())) {
                throw new Error(
                  state.lastError ??
                    "The configuration patch completed, but its authoritative refresh failed.",
                );
              }
            },
          );
          if (isCurrentConfigConnection(state, client, epoch)) {
            failedPatch = patched ? null : resolveOptions;
            if (patched) {
              options.reconcileDraft();
            }
          }
          return patched;
        } finally {
          options.reconcileAppliedRefresh();
        }
      })
      .finally(options.scheduleAutoSave);
  };
  return {
    queue,
    retry: (save: () => Promise<boolean>) => (failedPatch ? queue(failedPatch) : save()),
    clear: () => {
      failedPatch = null;
    },
  };
}
