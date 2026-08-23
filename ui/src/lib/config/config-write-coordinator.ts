import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { cloneConfigObject, serializeConfigForm } from "../config-form-utils.ts";
import {
  applyConfigSnapshot,
  removeConfigFormValue,
  resetConfigPendingChanges,
  serializeFormForSubmit,
  stageDefaultAgentConfigEntry,
  updateConfigFormValue,
  updateConfigRawValue,
} from "./config-draft-model.ts";
import {
  adoptConfigPatchAck,
  applyConfig,
  autoSaveConfig,
  executeConfigExternalMutation,
  loadConfig,
  patchConfig,
  saveConfig,
  teardownFlushConfigDraft,
  type ConfigPatchBuildResult,
  type ConfigWriteCoordinator,
  type ConfigMethod,
  type RuntimeConfigExternalMutationOptions,
  type RuntimeConfigExternalMutationResult,
} from "./config-gateway-operations.ts";
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
  canCallConfigMethod: (
    method: ConfigMethod,
    options?: { requireAdvertisement?: boolean },
  ) => boolean;
  cancelAppliedRefresh: () => void;
  reconcileAppliedRefresh: () => void;
  disposeAppliedRefresh: () => void;
  isDisposed: () => boolean;
};

export function createConfigWriteCoordinator({
  state,
  gateway,
  publish,
  run,
  mutate,
  trackLoad,
  resetLoads,
  resetConfigLoad,
  canCallConfigMethod,
  cancelAppliedRefresh,
  reconcileAppliedRefresh,
  disposeAppliedRefresh,
  isDisposed,
}: ConfigWriteCoordinatorContext): ConfigWriteCoordinator {
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let autoSaveInFlight: Promise<unknown> | null = null;
  let autoSaveTrailing = false;
  let autoSaveDraftConnection: { client: GatewayBrowserClient; epoch: number } | null = null;
  let autoSaveRequiresExplicitSubmit = false;
  let lastFlightSubmittedRaw: string | null = null;
  let lastFlightAckHash: string | null = null;
  let manualSubmitInFlight: Promise<unknown> | null = null;
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
  // Submission info of the pending manual SAVE (applies never register:
  // a post-apply write is meaningless while the gateway restarts, so the
  // teardown flush fail-closes on them).
  let manualFlightInfo: { raw: string; ackHash: string | null } | null = null;
  const clearAutoSaveDraftConnection = () => {
    autoSaveDraftConnection = null;
    autoSaveRequiresExplicitSubmit = false;
  };
  const captureAutoSaveDraftConnection = () => {
    if (
      autoSaveRequiresExplicitSubmit ||
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
  };
  const canAutoSaveDraftOnCurrentConnection = () =>
    !autoSaveRequiresExplicitSubmit &&
    autoSaveDraftConnection !== null &&
    autoSaveDraftConnection.client === state.client &&
    autoSaveDraftConnection.epoch === currentConfigConnectionEpoch(state);
  const reconcileAutoSaveDraftConnection = () => {
    if (state.configFormDirty && state.configFormMode === "form") {
      captureAutoSaveDraftConnection();
    } else if (autoSaveInFlight === null && manualSubmitInFlight === null) {
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
  const runAutoSave = () => {
    if (
      isDisposed() ||
      suppressAutoSave ||
      writesSuspended ||
      !canAutoSaveDraftOnCurrentConnection() ||
      !canCallConfigMethod("config.set")
    ) {
      return;
    }
    if (autoSaveInFlight ?? manualSubmitInFlight) {
      // Exactly one trailing save catches edits made while a write (auto or
      // manual — a concurrent config.set would race the same base hash) is
      // in flight; further edits fold into that same trailing run.
      autoSaveTrailing = true;
      return;
    }
    cancelAppliedRefresh();
    // Captured for teardown: dispose compares the latest draft against the
    // in-flight submission to decide whether a final flush is needed, and the
    // flush may only CAS against this flight's own ack hash.
    lastFlightSubmittedRaw = serializeFormForSubmit(state);
    lastFlightAckHash = null;
    const flight = run(() =>
      autoSaveConfig(
        state,
        (ackHash) => {
          lastFlightAckHash = ackHash;
        },
        () => canCallConfigMethod("config.set"),
      ),
    )
      .catch(() => false)
      .then((saved) => {
        // A connection change deregisters flights; a stale completion must
        // not clear a NEW flight's registration or steal its trailing state.
        if (autoSaveInFlight !== flight) {
          return;
        }
        autoSaveInFlight = null;
        reconcileAutoSaveDraftConnection();
        // One trailing save catches edits (or reverts back to the pre-save
        // value) made while the request was in flight. A still-armed debounce
        // timer owns its own save, and failed flights never self-retry.
        const wantsTrailing =
          autoSaveTrailing ||
          (saved &&
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
    autoSaveInFlight = flight;
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
      !canAutoSaveDraftOnCurrentConnection() ||
      !canCallConfigMethod("config.set") ||
      !state.configFormDirty ||
      state.configFormMode !== "form"
    ) {
      return;
    }
    // A conflict proves the snapshot is stale; retrying against the same base
    // hash would fail again and mask the reload warning with "Saving…". Only
    // a discard/reload (which installs a fresh snapshot) re-enables autosave.
    if (state.configAutoSaveStatus === "conflict") {
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
      const flight = autoSaveInFlight ?? manualSubmitInFlight;
      if (!flight) {
        return;
      }
      // Race the connection wake: a disconnect deregisters in-flight writes,
      // and a drain already awaiting one resumes from that deregistration
      // instead of depending on the transport's close-time rejection order.
      await Promise.race([flight, connectionWakePromise]);
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
    if (autoSaveInFlight ?? manualSubmitInFlight) {
      suppressAutoSave = true;
      try {
        await drainPendingWrites();
      } finally {
        suppressAutoSave = false;
      }
    }
  };
  // Explicit ops (save/apply/patch) also serialize among THEMSELVES: two
  // callers queued behind the same in-flight write would otherwise both
  // finish draining and dispatch against the same base hash.
  let explicitOpQueue: Promise<unknown> | null = null;
  const afterPendingWritesSettled = <T>(
    task: () => Promise<T>,
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
        if (autoSaveInFlight ?? manualSubmitInFlight) {
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
        manualFlightInfo = null;
        const submit = task();
        const settled = submit
          .catch(() => unavailable)
          .then(() => {
            if (manualSubmitInFlight !== settled) {
              return;
            }
            manualSubmitInFlight = null;
            // Edits made during the manual flight deferred their autosave
            // (runAutoSave treats manual flights as active writes); give them
            // their one trailing run. runAutoSave self-guards suspension.
            const wantsTrailing = autoSaveTrailing;
            autoSaveTrailing = false;
            if (wantsTrailing) {
              runAutoSave();
            }
          });
        manualSubmitInFlight = settled;
        return await submit;
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
    const connected = snapshot.phase === "connected";
    const connectionChanged = state.connected !== connected;
    state.client = snapshot.client;
    state.connected = connected;
    state.applySessionKey = snapshot.sessionKey;
    if (clientChanged || connectionChanged) {
      const draftBelongsToPreviousConnection =
        state.configFormMode === "form" &&
        (state.configFormDirty || autoSaveInFlight !== null || manualSubmitInFlight !== null);
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
        // Save/Apply or reload before the new Gateway may receive it.
        autoSaveRequiresExplicitSubmit = true;
      }
      if (autoSaveInFlight !== null || manualSubmitInFlight !== null) {
        // The epoch guard already blocks these flights from mutating state;
        // deregistering releases drain barriers and the trailing-save chain
        // promptly instead of waiting on the transport's close-time
        // rejection (protocol-client flushRequests rejects all pending
        // requests on socket close, so nothing here can hang forever).
        // Remember the uncertain submission for reconnect reconciliation.
        hasInterruptedWrite = true;
        interruptedWriteRaw =
          autoSaveInFlight !== null ? lastFlightSubmittedRaw : (manualFlightInfo?.raw ?? null);
        autoSaveInFlight = null;
        manualSubmitInFlight = null;
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
          const draftFormBefore =
            state.configFormMode === "form" && !state.configFormDirty && state.configForm
              ? cloneConfigObject(state.configForm)
              : null;
          const draftRawBefore = draftFormBefore ? serializeConfigForm(draftFormBefore) : null;
          const reconcile = run(() => loadConfig(state));
          void trackLoad("config", reconcile);
          void reconcile.then((loaded) => {
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
              const freshHash = state.configSnapshot.hash ?? null;
              if (state.configSnapshot.appliedConfigHash === undefined) {
                state.configNeedsApply = true;
              }
              if (state.configFormDirty) {
                if (serializeFormForSubmit(state) === interruptedRaw) {
                  // The lost acknowledgement was the only missing event: the
                  // retained bytes are already authoritative, so no draft
                  // remains to submit on the replacement connection.
                  applyConfigSnapshot(state, state.configSnapshot, {
                    discardPendingChanges: true,
                  });
                  clearAutoSaveDraftConnection();
                } else {
                  state.configDraftBaseHash = freshHash ?? state.configDraftBaseHash;
                }
              } else if (
                draftFormBefore &&
                draftRawBefore !== null &&
                draftRawBefore !== interruptedRaw
              ) {
                // Reverted-while-in-flight: the clean-looking pre-reload
                // draft differs from the committed bytes, so it was a real
                // revert. Restore it as a dirty draft on the fresh base so
                // the rescheduled autosave writes it back.
                state.configForm = draftFormBefore;
                state.configRaw = draftRawBefore;
                state.configFormMode = "form";
                state.configFormDirty = true;
                state.configDraftBaseHash = freshHash ?? state.configDraftBaseHash;
              }
            }
            publish();
            reconcileAppliedRefresh();
          });
        } else {
          reconcileAppliedRefresh();
        }
      }
    }
    publish();
  });

  const queueConfigPatch = (resolveOptions: () => ConfigPatchBuildResult): Promise<boolean> => {
    cancelAppliedRefresh();
    return afterPendingWritesSettled(
      async () => {
        // A drained autosave can start its own refresh while this patch waits.
        cancelAppliedRefresh();
        try {
          const resolved = resolveOptions();
          if ("error" in resolved) {
            state.lastError = resolved.error;
            return false;
          }
          return await patchConfig(state, resolved.options, async (ack, snapshotAtDispatch) => {
            // The ack is newer than every config.get that began before it.
            // Detach and invalidate those loads so stale pre-patch responses
            // cannot replace the acknowledged config/hash.
            resetConfigLoad();
            nextRequestVersion(state, "config");
            state.configLoading = false;
            if (asConfigRecord(ack.config)) {
              adoptConfigPatchAck(state, ack, snapshotAtDispatch);
              return;
            }
            // Older/hash-only acknowledgements do not carry enough data to
            // pair their new hash with a safe local document. Force a fresh
            // snapshot instead of publishing an inconsistent hash/config.
            const refresh = run(() => loadConfig(state));
            void trackLoad("config", refresh);
            if (!(await refresh)) {
              throw new Error(
                state.lastError ??
                  "The configuration patch completed, but its authoritative refresh failed.",
              );
            }
          });
        } finally {
          reconcileAppliedRefresh();
        }
      },
      false,
      {
        flushScheduledDraft: true,
        canDispatch: () => canCallConfigMethod("config.patch"),
      },
    ).finally(() => {
      scheduleAutoSave();
    });
  };
  return {
    prepareDiscard: drainWritesForDiscard,
    patchForm: (path, value) => {
      mutate(() => updateConfigFormValue(state, path, value));
      reconcileAutoSaveDraftConnection();
      scheduleAutoSave();
    },
    removeFormValue: (path) => {
      mutate(() => removeConfigFormValue(state, path));
      reconcileAutoSaveDraftConnection();
      scheduleAutoSave();
    },
    setRaw: (value) => mutate(() => updateConfigRawValue(state, value)),
    resetDraft: () => {
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
        canCallConfigMethod("config.set") && (options.canDispatch?.() ?? true);
      return !canDispatch()
        ? Promise.resolve(false)
        : afterPendingWritesSettled(
            async () => {
              bindDraftToExplicitSubmit();
              cancelAppliedRefresh();
              try {
                const saved = await saveConfig(
                  state,
                  (info) => {
                    manualFlightInfo = info;
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
    apply: () =>
      !canCallConfigMethod("config.apply")
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
                const applied = await applyConfig(state, () => canCallConfigMethod("config.apply"));
                reconcileAutoSaveDraftConnection();
                return applied;
              } finally {
                reconcileAppliedRefresh();
              }
            },
            false,
            { canDispatch: () => canCallConfigMethod("config.apply") },
          ),
    stageDefaultAgent: (agentId) => {
      if (!canCallConfigMethod("config.set")) {
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
      canCallConfigMethod("config.patch") && (options.canDispatch?.() ?? true)
        ? queueConfigPatch(() => ({ options }))
        : Promise.resolve(false),
    patchFromSnapshot: (build) =>
      canCallConfigMethod("config.patch")
        ? queueConfigPatch(() => {
            const config = resolveEditableSnapshotConfig(state.configSnapshot);
            return config
              ? build(config)
              : { error: "Configuration is unavailable; refresh and try again." };
          })
        : Promise.resolve(false),
    runExternalMutation: async <T>(
      task: (client: GatewayBrowserClient) => Promise<T>,
      options: RuntimeConfigExternalMutationOptions = {},
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
                // Do not join a config.get that started before the external RPC.
                const refresh = run(() => loadConfig(state));
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
        canAutoSaveDraftOnCurrentConnection() &&
        canCallConfigMethod("config.set");
      const autoFlight = autoSaveInFlight;
      const pendingFlight = autoFlight ?? manualSubmitInFlight;
      cancelScheduledAutoSave();
      disposeAppliedRefresh();
      if (canFlush && pendingFlight) {
        void pendingFlight.then(() => {
          // The settled flight could not update dirty/base state past the
          // epoch guard; a draft whose bytes differ from that submission is a
          // newer edit and gets exactly one chained final save — never a
          // parallel one. Auto flights report via lastFlight*, manual saves
          // via manualFlightInfo; applies never register info (a post-apply
          // write is meaningless while the gateway restarts), and without the
          // flight's own ack hash there is no CAS base we can trust — both
          // fail closed rather than risk clobbering a foreign write.
          const submitted = autoFlight
            ? { raw: lastFlightSubmittedRaw, ackHash: lastFlightAckHash }
            : manualFlightInfo;
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
        void autoSaveConfig(state, undefined, () => canCallConfigMethod("config.set"));
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
}
