import {
  adoptConfigPatchAck,
  patchConfig,
  type ConfigPatchBuildResult,
} from "./config-gateway-operations.ts";
import {
  currentConfigConnectionEpoch,
  isCurrentConfigConnection,
  type RuntimeConfigState,
} from "./config-state-model.ts";

export function createConfigPatchCoordinator(options: {
  state: RuntimeConfigState;
  dispatch: (task: () => Promise<boolean>) => Promise<boolean>;
  invalidateConfigLoad: () => void;
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
          const patched = await patchConfig(state, resolved.options, (ack, snapshotAtDispatch) => {
            options.invalidateConfigLoad();
            adoptConfigPatchAck(state, ack, snapshotAtDispatch);
          });
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
