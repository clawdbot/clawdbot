import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { cloneConfigObject } from "../config-form-utils.ts";
import {
  rebaseConfigDraft,
  removeConfigFormValue,
  resetConfigPendingChanges,
  serializeFormForSubmit,
  stageDefaultAgentConfigEntry,
  updateConfigFormValue,
  updateConfigRawValue,
} from "./config-draft-model.ts";
import {
  executeConfigExternalMutation,
  loadConfig,
  refreshDraft,
  refreshConfigAfterMutation,
  submitConfigDraft,
  type ConfigSubmission,
  type ConfigSubmissionObserver,
  teardownFlushConfigDraft,
  type ConfigWriteCoordinator,
  type ConfigMethod,
  type RuntimeConfigExternalMutationOptions,
  type RuntimeConfigExternalMutationResult,
} from "./config-gateway-operations.ts";
import { createConfigPatchCoordinator } from "./config-patch-coordinator.ts";
import {
  currentConfigConnectionEpoch,
  invalidateConfigConnection,
  isCurrentConfigConnection,
  nextRequestVersion,
  resolveEditableSnapshotConfig,
  type RuntimeConfigGateway,
  type RuntimeConfigState,
} from "./config-state-model.ts";

/** Debounce window between the last form edit and its automatic config.set. */
const CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS = 800;

type ConfigWriteCoordinatorContext = {
  state: RuntimeConfigState;
  gateway: RuntimeConfigGateway;
  publish: () => void;
  run: <T>(task: () => Promise<T>) => Promise<T>;
  mutate: (task: () => void) => void;
  trackLoad: (key: "config" | "schema", promise: Promise<unknown>) => Promise<void>;
  resetLoads: () => void;
  resetConfigLoad: () => void;
  refreshConnectionState: (beforeApplySnapshot?: () => void) => Promise<boolean>;
  canCallConfigMethod: (
    method: ConfigMethod,
    options?: { requireAdvertisement?: boolean },
  ) => boolean;
  cancelAppliedRefresh: () => void;
  reconcileAppliedRefresh: () => void;
  disposeAppliedRefresh: () => void;
  isDisposed: () => boolean;
};

type ConfigWriteFlight = { promise: Promise<unknown>; submission: ConfigSubmission | null };

export function createConfigWriteCoordinator({
  state,
  gateway,
  publish,
  run,
  mutate,
  trackLoad,
  resetLoads,
  resetConfigLoad,
  refreshConnectionState,
  canCallConfigMethod,
  cancelAppliedRefresh,
  reconcileAppliedRefresh,
  disposeAppliedRefresh,
  isDisposed,
}: ConfigWriteCoordinatorContext): ConfigWriteCoordinator {
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: ConfigWriteFlight | null = null;
  let autoSaveTrailing = false;
  let autoSaveDraftConnection: { client: GatewayBrowserClient; epoch: number } | null = null;
  let autoSaveRequiresExplicitSubmit = false;
  // A write interrupted by a connection change may or may not have committed;
  // remembered across the disconnect so the reconnect can reconcile against a
  // fresh snapshot before autosave resumes.
  let hasInterruptedWrite = false;
  let interruptedWriteRaw: string | null = null;
  // Blocks trailing autosaves while a discard drains pending writes; the
  // drained draft is about to be thrown away, not re-written.
  let suppressAutoSave = false;
  // Wakes drains awaiting a request a connection change just orphaned — that
  // request may never settle, and a drain stuck on it would wedge the app
  // updater barrier, applies, and discards until then.
  let connectionWake: (() => void) | null = null;
  let connectionWakePromise: Promise<void> = Promise.resolve();
  const armConnectionWake = () => {
    connectionWakePromise = new Promise((resolve) => {
      connectionWake = resolve;
    });
  };
  armConnectionWake();
  // App-updater interlock: config writes or gateway restarts mid-update can
  // corrupt the install, so all writes pause until the updater settles.
  let writesSuspended = false;
  let writesResumed: (() => void) | null = null;
  let writesResumedPromise: Promise<void> = Promise.resolve();
  const canDispatchConfigMutation = (method: ConfigMethod): boolean => {
    const allowed = canCallConfigMethod(method);
    if (!allowed && state.connected) {
      state.lastError = t("configView.adminRequired");
      publish();
    }
    return allowed;
  };
  const clearAutoSaveDraftConnection = () => {
    autoSaveDraftConnection = null;
    autoSaveRequiresExplicitSubmit = false;
    if (state.configAutoSaveStatus === "paused") {
      state.configAutoSaveStatus = "idle";
    }
  };
  const pauseAutoSaveDraftConnection = () => {
    autoSaveRequiresExplicitSubmit = true;
    // Conflict outranks the reconnect latch: the snapshot is still stale.
    if (state.configFormMode === "form" && state.configAutoSaveStatus !== "conflict") {
      state.configAutoSaveStatus = "paused";
    }
  };
  const captureAutoSaveDraftConnection = () => {
    if (autoSaveRequiresExplicitSubmit) {
      pauseAutoSaveDraftConnection();
      return;
    }
    if (
      autoSaveDraftConnection ||
      !state.client ||
      !state.connected ||
      !state.configFormDirty ||
      state.configFormMode !== "form"
    ) {
      return;
    }
    autoSaveDraftConnection = {
      client: state.client,
      epoch: currentConfigConnectionEpoch(state),
    };
  };
  const bindDraftToExplicitSubmit = () => {
    if (!state.client || !state.connected || state.configFormMode !== "form") {
      return;
    }
    autoSaveDraftConnection = {
      client: state.client,
      epoch: currentConfigConnectionEpoch(state),
    };
    autoSaveRequiresExplicitSubmit = false;
    if (state.configAutoSaveStatus === "paused") {
      state.configAutoSaveStatus = "idle";
    }
  };
  // Stale bases and previous connections require explicit recovery, including teardown.
  const canAutoSaveDraft = () =>
    state.configAutoSaveStatus !== "conflict" &&
    !autoSaveRequiresExplicitSubmit &&
    autoSaveDraftConnection !== null &&
    autoSaveDraftConnection.client === state.client &&
    autoSaveDraftConnection.epoch === currentConfigConnectionEpoch(state);
  const reconcileAutoSaveDraftConnection = () => {
    if (state.configFormDirty) {
      captureAutoSaveDraftConnection();
    } else if (inFlight === null) {
      clearAutoSaveDraftConnection();
    }
  };
  const cancelScheduledAutoSave = () => {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    autoSaveTrailing = false;
  };
  const invalidateConfigLoad = () => {
    resetConfigLoad();
    nextRequestVersion(state, "config");
    state.configLoading = false;
  };
  const trackWrite = <T>(
    task: (onSubmitted: ConfigSubmissionObserver) => Promise<T>,
    auto = false,
  ): Promise<T> => {
    const flight: ConfigWriteFlight = { promise: Promise.resolve(), submission: null };
    const submit = task((submission) => {
      flight.submission = submission;
      // Keep the ack for teardown, but only a live flight may retire older loads.
      if (submission.ackHash && !isDisposed() && inFlight === flight) {
        invalidateConfigLoad();
      }
    });
    flight.promise = submit
      .catch(() => false)
      .then((saved) => {
        // Disconnect deregisters the flight; its late completion must not steal
        // the replacement connection's registration or trailing save.
        if (inFlight !== flight) {
          return;
        }
        inFlight = null;
        // Explicit operations own recovery status; a failed patch must keep its Retry action.
        if (auto) {
          reconcileAutoSaveDraftConnection();
        }
        const wantsTrailing =
          autoSaveTrailing ||
          (auto &&
            saved &&
            state.configFormDirty &&
            state.configFormMode === "form" &&
            autoSaveTimer === null);
        autoSaveTrailing = false;
        if (wantsTrailing && !isDisposed()) {
          runAutoSave();
        } else {
          reconcileAppliedRefresh();
        }
      });
    inFlight = flight;
    return submit;
  };
  const runAutoSave = () => {
    if (
      isDisposed() ||
      suppressAutoSave ||
      writesSuspended ||
      !canAutoSaveDraft() ||
      !canCallConfigMethod("config.set")
    ) {
      return;
    }
    if (inFlight) {
      // Edits during any write fold into one trailing autosave on its new base.
      autoSaveTrailing = true;
      return;
    }
    cancelAppliedRefresh();
    void trackWrite(
      (onSubmitted) =>
        run(() =>
          submitConfigDraft(state, "auto", onSubmitted, () => {
            if (!canCallConfigMethod("config.set")) {
              return false;
            }
            patches.clear();
            return true;
          }),
        ),
      true,
    ).catch(() => undefined);
  };
  const flushScheduledAutoSave = () => {
    if (!autoSaveTimer) {
      return;
    }
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    runAutoSave();
  };
  const scheduleAutoSave = () => {
    // Only form-draft edits auto-save; raw-text drafts stay manual so a
    // half-typed JSON5 buffer never gets written to disk. Suspended writes
    // (app updater running) stay dirty and reschedule when suspension lifts.
    if (
      isDisposed() ||
      writesSuspended ||
      !canAutoSaveDraft() ||
      !canCallConfigMethod("config.set") ||
      !state.configFormDirty ||
      state.configFormMode !== "form"
    ) {
      return;
    }
    cancelAppliedRefresh();
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
    }
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null;
      runAutoSave();
    }, CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
  };
  // Manual save/apply serialize the current draft themselves; cancel any
  // dangling debounce and settle an in-flight autosave first so the explicit
  // write does not race it on the baseHash guard. The submit starts
  // synchronously when nothing is in flight so it binds to the current
  // connection epoch.
  // Drains ALL pending config writes: the autosave chain (a settling flight
  // can spawn a trailing save) AND any manual Save still in flight.
  const drainPendingWrites = async (flushScheduledDraft = false): Promise<void> => {
    while (true) {
      if (flushScheduledDraft) {
        flushScheduledAutoSave();
      }
      const flight = inFlight;
      if (!flight) {
        return;
      }
      // Race the connection wake: a disconnect deregisters in-flight writes,
      // and a drain already awaiting one resumes from that deregistration
      // instead of depending on the transport's close-time rejection order.
      await Promise.race([flight.promise, connectionWakePromise]);
      if (isDisposed()) {
        return;
      }
      if (!flushScheduledDraft) {
        // save/apply submit the latest full draft themselves. Edits made
        // while the preceding flight settled may have armed a fresh debounce;
        // cancel it before the explicit write starts or it can race the same
        // post-flight base hash.
        cancelScheduledAutoSave();
      }
    }
  };
  // Discard barrier shared by discardDraft and refresh({discardPendingChanges}):
  // settle pending writes with trailing saves suppressed so a late completion
  // cannot trail the just-discarded bytes back to disk.
  const drainWritesForDiscard = async (): Promise<void> => {
    cancelScheduledAutoSave();
    if (inFlight) {
      suppressAutoSave = true;
      try {
        await drainPendingWrites();
      } finally {
        suppressAutoSave = false;
      }
    }
    patches.clear();
  };
  // Explicit ops (save/apply/patch) also serialize among THEMSELVES: two
  // callers queued behind the same in-flight write would otherwise both
  // finish draining and dispatch against the same base hash.
  let explicitOpQueue: Promise<unknown> | null = null;
  const afterPendingWritesSettled = <T>(
    task: (onSubmitted: ConfigSubmissionObserver) => Promise<T>,
    unavailable: T,
    options: { flushScheduledDraft?: boolean; canDispatch?: () => boolean } = {},
  ): Promise<T> => {
    if (writesSuspended) {
      return Promise.resolve(unavailable);
    }
    const client = state.client;
    const connectionEpoch = currentConfigConnectionEpoch(state);
    if (options.flushScheduledDraft) {
      flushScheduledAutoSave();
    } else {
      cancelScheduledAutoSave();
    }
    // Start synchronously when no explicit op is queued so the submit binds
    // to the CURRENT connection epoch; only genuine queuing pays the hop.
    const start = () =>
      run(async () => {
        // Drain before the explicit op — otherwise an apply could race a
        // pending config.set on the same base hash into a CAS failure.
        if (inFlight) {
          await drainPendingWrites(options.flushScheduledDraft);
        }
        // The updater may have started while we drained; suspension must be a
        // real barrier or an apply could restart the gateway mid-update.
        if (writesSuspended || isDisposed()) {
          return unavailable;
        }
        if (!client || !isCurrentConfigConnection(state, client, connectionEpoch)) {
          return unavailable;
        }
        // Hello method/scope metadata can change while the client and
        // connection epoch stay stable. Recheck at the dispatch boundary.
        if (options.canDispatch && !options.canDispatch()) {
          return unavailable;
        }
        return await trackWrite(task);
      });
    const queued = explicitOpQueue ? explicitOpQueue.then(start) : start();
    const tail: Promise<unknown> = queued
      .catch(() => false)
      .then(() => {
        if (explicitOpQueue === tail) {
          explicitOpQueue = null;
        }
      });
    explicitOpQueue = tail;
    return queued;
  };
  const stopGateway = gateway.subscribe((snapshot) => {
    const clientChanged = state.client !== snapshot.client;
    const connectionChanged = state.connected !== (snapshot.phase === "connected");
    state.client = snapshot.client;
    state.connected = snapshot.phase === "connected";
    state.applySessionKey = snapshot.sessionKey;
    if (clientChanged || connectionChanged) {
      patches.clear();
      const draftBelongsToPreviousConnection = state.configFormDirty || inFlight !== null;
      resetLoads();
      // A dead prior-connection flight must not keep the reconnected owner's
      // explicit-operation FIFO waiting forever.
      explicitOpQueue = null;
      // A reconnect may reuse the client object. Keep generations monotonic so work
      // from the previous connection cannot commit into the new connection epoch.
      invalidateConfigConnection(state);
      cancelScheduledAutoSave();
      cancelAppliedRefresh();
      if (draftBelongsToPreviousConnection) {
        // A retained draft belongs to the Gateway connection where the edit
        // began. Preserve it across replacement, but require an explicit
        // Save/Apply or reload before the new Gateway may receive it. The
        // latch must be visible: without a rendered state the form looks
        // normal while every subsequent edit silently never saves.
        pauseAutoSaveDraftConnection();
      }
      if (inFlight !== null) {
        // The epoch guard already blocks these flights from mutating state;
        // deregistering releases drain barriers and the trailing-save chain
        // promptly instead of waiting on the transport's close-time
        // rejection (protocol-client flushRequests rejects all pending
        // requests on socket close, so nothing here can hang forever).
        // Remember the uncertain submission for reconnect reconciliation.
        hasInterruptedWrite = true;
        interruptedWriteRaw = inFlight.submission?.raw ?? null;
        inFlight = null;
        autoSaveTrailing = false;
      }
      // Re-arm before waking so a resumed drain that loops again races the
      // fresh (still-pending) signal, not the one just resolved.
      const wake = connectionWake;
      armConnectionWake();
      wake?.();
      state.configLoading = false;
      state.configSchemaLoading = false;
      state.configSaving = false;
      state.configApplying = false;
      if (state.configAutoSaveStatus === "saving") {
        state.configAutoSaveStatus = "idle";
      }
      if (state.connected && state.client) {
        if (hasInterruptedWrite) {
          // The interrupted write may or may not have committed. Fetch the
          // authoritative snapshot so an uncertain flight cannot leave a
          // clean-looking draft or a stale base. Replacement connections
          // never resume autosave for the retained draft.
          const interruptedRaw = interruptedWriteRaw;
          // A revert made while the write was in flight reads clean (the ack
          // never rebased the originals), so the reload below would replace
          // it with the committed bytes. Capture it for restoration.
          const captureDraft = () => ({
            form: cloneConfigObject(state.configForm ?? {}),
            raw: state.configRaw,
            mode: state.configFormMode,
            submittedRaw: state.configFormDirty ? serializeFormForSubmit(state) : state.configRaw,
          });
          let draftBefore: ReturnType<typeof captureDraft> | null = null;
          void refreshConnectionState(() => {
            draftBefore = state.configFormDirty ? null : captureDraft();
          }).then((loaded) => {
            if (isDisposed()) {
              return;
            }
            if (!loaded || !state.connected) {
              // Reload failed or the connection flipped again: keep the
              // interruption metadata so the NEXT reconnect retries
              // reconciliation instead of silently taking the plain path.
              reconcileAppliedRefresh();
              return;
            }
            hasInterruptedWrite = false;
            interruptedWriteRaw = null;
            // If the interrupted write DID commit, the fresh snapshot is
            // exactly its bytes. Rebase a surviving draft onto the fresh hash
            // so the retry doesn't false-conflict against our own write. Any
            // other server content keeps the old base and conflicts instead
            // of clobbering a foreign writer.
            if (interruptedRaw !== null && state.configSnapshot?.raw === interruptedRaw) {
              if (state.configSnapshot.appliedConfigHash === undefined) {
                state.configNeedsApply = true;
              }
              const pendingDraft = state.configFormDirty ? captureDraft() : draftBefore;
              // Rebase originals and hash together, then retain newer edits or
              // a pre-ack revert. Raw bytes and mode stay manual-save-only.
              if (pendingDraft && pendingDraft.submittedRaw !== interruptedRaw) {
                rebaseConfigDraft(state);
                state.configForm = pendingDraft.form;
                state.configRaw = pendingDraft.raw;
                state.configFormMode = pendingDraft.mode;
                state.configFormDirty = true;
                pauseAutoSaveDraftConnection();
              } else {
                resetConfigPendingChanges(state);
                state.configAutoSaveStatus = "idle";
                clearAutoSaveDraftConnection();
              }
            }
            publish();
            reconcileAppliedRefresh();
          });
        } else {
          void refreshDraft(state, refreshConnectionState, publish, reconcileAppliedRefresh);
        }
      }
    }
    publish();
  });

  const patches = createConfigPatchCoordinator({
    state,
    reconcileDraft: reconcileAutoSaveDraftConnection,
    dispatch: (task) =>
      afterPendingWritesSettled(task, false, {
        flushScheduledDraft: true,
        canDispatch: () => canDispatchConfigMutation("config.patch"),
      }),
    invalidateConfigLoad,
    cancelAppliedRefresh,
    reconcileAppliedRefresh,
    scheduleAutoSave,
  });
  const mutateDraft = (mutation: () => void) => {
    mutate(mutation);
    reconcileAutoSaveDraftConnection();
    scheduleAutoSave();
  };
  const writes: ConfigWriteCoordinator = {
    prepareDiscard: drainWritesForDiscard,
    patchForm: (path, value) => mutateDraft(() => updateConfigFormValue(state, path, value)),
    removeFormValue: (path) => mutateDraft(() => removeConfigFormValue(state, path)),
    setRaw: (value) => mutateDraft(() => updateConfigRawValue(state, value)),
    resetDraft: () => {
      patches.clear();
      cancelScheduledAutoSave();
      mutate(() => resetConfigPendingChanges(state));
      clearAutoSaveDraftConnection();
      reconcileAppliedRefresh();
    },
    discardDraft: async () => {
      // Settle pending writes first (with trailing saves suppressed — the
      // draft is being thrown away, not re-written) so a late ack cannot
      // re-dirty or trail-write over the discard.
      await drainWritesForDiscard();
      if (state.connected && state.client) {
        cancelAppliedRefresh();
        try {
          await trackLoad(
            "config",
            run(() => loadConfig(state, { discardPendingChanges: true })),
          );
          clearAutoSaveDraftConnection();
        } finally {
          reconcileAppliedRefresh();
        }
        return;
      }
      // Offline: a network refresh would silently no-op and strand the
      // draft; fall back to a pure local reset onto the snapshot originals.
      mutate(() => {
        resetConfigPendingChanges(state);
        // Conflict marks the snapshot itself stale; an offline reset onto
        // those stale originals must NOT pretend to have reconciled — only a
        // connected reload clears conflict (same invariant as elsewhere).
        if (state.configAutoSaveStatus !== "conflict") {
          state.configAutoSaveStatus = "idle";
          state.lastError = null;
        }
      });
      clearAutoSaveDraftConnection();
    },
    setWritesSuspended: (suspended) => {
      if (writesSuspended === suspended) {
        return;
      }
      writesSuspended = suspended;
      if (suspended) {
        cancelScheduledAutoSave();
        writesResumedPromise = new Promise((resolve) => {
          writesResumed = resolve;
        });
      } else {
        const resume = writesResumed;
        writesResumed = null;
        resume?.();
        // Edits made during the update save once it ends.
        scheduleAutoSave();
      }
    },
    waitForPendingWrites: () => {
      // A debounce timer represents pending persisted intent too. Convert it
      // into a tracked flight before draining so external writers cannot race
      // the draft simply because the user clicked again within 800 ms.
      flushScheduledAutoSave();
      return drainPendingWrites(true);
    },
    save: (options = {}) => {
      const canDispatch = () =>
        canDispatchConfigMutation("config.set") && (options.canDispatch?.() ?? true);
      return !canDispatch()
        ? Promise.resolve(false)
        : afterPendingWritesSettled(
            async (onSubmitted) => {
              bindDraftToExplicitSubmit();
              cancelAppliedRefresh();
              try {
                const saved = await submitConfigDraft(
                  state,
                  "save",
                  (submission) => {
                    if (submission.ackHash === null) {
                      patches.clear();
                    }
                    onSubmitted(submission);
                  },
                  canDispatch,
                );
                reconcileAutoSaveDraftConnection();
                return saved;
              } finally {
                reconcileAppliedRefresh();
              }
            },
            false,
            { canDispatch },
          );
    },
    retry: () => patches.retry(writes.save),
    apply: () =>
      !canDispatchConfigMutation("config.apply")
        ? Promise.resolve(false)
        : afterPendingWritesSettled(
            async () => {
              bindDraftToExplicitSubmit();
              cancelAppliedRefresh();
              // Checked after the drain: a raw draft whose explicit Save is in
              // flight resolves clean and may apply. A raw draft that is STILL
              // dirty here was never reviewed-saved — applying would implicitly
              // write unreviewed raw text, so refuse and point at the Raw editor.
              if (state.configFormDirty && state.configFormMode === "raw") {
                state.configAutoSaveStatus = "error";
                state.lastError = t("configView.rawDraftBlocksApply");
                reconcileAppliedRefresh();
                return false;
              }
              try {
                const applied = await submitConfigDraft(state, "apply", undefined, () => {
                  if (!canDispatchConfigMutation("config.apply")) {
                    return false;
                  }
                  patches.clear();
                  return true;
                });
                reconcileAutoSaveDraftConnection();
                return applied;
              } finally {
                reconcileAppliedRefresh();
              }
            },
            false,
            { canDispatch: () => canDispatchConfigMutation("config.apply") },
          ),
    stageDefaultAgent: (agentId) => {
      if (!canDispatchConfigMutation("config.set")) {
        return false;
      }
      const changed = stageDefaultAgentConfigEntry(state, agentId);
      publish();
      reconcileAutoSaveDraftConnection();
      scheduleAutoSave();
      return changed;
    },
    // Patches are config writes too: they must honor updater suspension and
    // register as a drainable flight, or a patch could overlap update.run.
    // Unlike save/apply, a patch does not submit the form draft — flush a
    // scheduled autosave into a flight first (the settle below drains it) and
    // re-arm the debounce after so a dirty form is never left timer-less.
    patch: (options) =>
      canDispatchConfigMutation("config.patch") && (options.canDispatch?.() ?? true)
        ? patches.queue(() => ({ options }))
        : Promise.resolve(false),
    patchFromSnapshot: (build) =>
      canDispatchConfigMutation("config.patch")
        ? patches.queue(() => {
            const config = resolveEditableSnapshotConfig(state.configSnapshot);
            return config
              ? build(config)
              : { error: "Configuration is unavailable; refresh and try again." };
          })
        : Promise.resolve(false),
    runExternalMutation: async <T>(
      task: (client: GatewayBrowserClient) => Promise<T>,
      options: RuntimeConfigExternalMutationOptions<T> = {},
    ): Promise<RuntimeConfigExternalMutationResult<T>> => {
      const mutationClient = state.client;
      const mutationConnectionEpoch = currentConfigConnectionEpoch(state);
      while (true) {
        if (options.waitForWritesResumed && writesSuspended && !isDisposed()) {
          await writesResumedPromise;
        }
        const unavailable: RuntimeConfigExternalMutationResult<T> = {
          ok: false,
          reason: writesSuspended ? "suspended" : "unavailable",
          error: writesSuspended
            ? "Configuration writes are temporarily suspended."
            : "Configuration is unavailable; reconnect and try again.",
        };
        if (
          !mutationClient ||
          !isCurrentConfigConnection(state, mutationClient, mutationConnectionEpoch)
        ) {
          return {
            ok: false,
            reason: "unavailable",
            error: "Connection changed before the configuration update started.",
          };
        }
        const result = await afterPendingWritesSettled<RuntimeConfigExternalMutationResult<T>>(
          () =>
            executeConfigExternalMutation(
              state,
              mutationClient,
              mutationConnectionEpoch,
              task,
              options,
              async () => {
                const refresh = run(() => refreshConfigAfterMutation(state));
                void trackLoad("config", refresh);
                return await refresh;
              },
            ),
          unavailable,
          { flushScheduledDraft: true },
        );
        if (
          !(
            options.waitForWritesResumed &&
            !isDisposed() &&
            !result.ok &&
            (result.reason === "suspended" || writesSuspended)
          )
        ) {
          return result;
        }
      }
    },
    dispose() {
      patches.clear();
      writesResumed?.();
      writesResumed = null;
      // Free any drain awaiting a flight that will never be reconciled now;
      // the isDisposed() guard exits its loop.
      connectionWake?.();
      // SPA teardown right after an edit must not silently drop it: fire one
      // last save before timers die. Fire-and-forget — the request leaves
      // synchronously (or chains once behind an in-flight save) and the
      // stale-epoch guards skip all state mutation once the connection is
      // invalidated below.
      const client = state.client;
      const canFlush =
        state.connected &&
        client !== null &&
        state.configFormMode === "form" &&
        !writesSuspended &&
        canAutoSaveDraft() &&
        canCallConfigMethod("config.set");
      const pendingFlight = inFlight;
      cancelScheduledAutoSave();
      disposeAppliedRefresh();
      if (canFlush && pendingFlight) {
        void pendingFlight.promise.then(() => {
          // The settled flight could not update dirty/base state past the
          // epoch guard; a draft whose bytes differ from that submission is a
          // newer edit and gets exactly one chained final save — never a
          // parallel one. Applies and external mutations never register submission
          // info: only this save's own ack is a safe CAS base for a final flush.
          const submitted = pendingFlight.submission;
          const ackHash = submitted?.ackHash ?? null;
          const submittedRaw = submitted?.raw ?? null;
          // Bytes-vs-submission is the only trustworthy signal here: the
          // epoch guard blocked the ack's rebase, so a revert back to the
          // pre-save value reads configFormDirty=false while the persisted
          // bytes are still the unreverted submission.
          if (ackHash && submittedRaw !== null && serializeFormForSubmit(state) !== submittedRaw) {
            teardownFlushConfigDraft(state, client, ackHash, () =>
              canCallConfigMethod("config.set"),
            );
          }
        });
      } else if (canFlush && state.configFormDirty) {
        void submitConfigDraft(state, "auto", undefined, () => canCallConfigMethod("config.set"));
      }
      invalidateConfigConnection(state);
      state.connected = false;
      state.configLoading = false;
      state.configSchemaLoading = false;
      state.configSaving = false;
      state.configApplying = false;
      stopGateway();
    },
  };
  return writes;
}
