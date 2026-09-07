// Implementation of the Control UI's disruptive-update dialog. It stays behind
// the `update-confirmation.ts` lazy boundary because nothing here runs until an
// operator clicks an update affordance, and the startup bundle has no room for
// a dialog nobody has opened yet.
//
// The dialog is the operator's primary surface for the whole update: it opens
// as a confirmation, becomes a progress report on confirm, and reports a
// failure in place. It is mounted on `document.body`, outside the shell, so the
// Gateway restart that tears down the connection cannot unmount it.
import { html, nothing, render } from "lit";
import type { UpdateRunRecord } from "../../../src/infra/update-run-record.ts";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { registerUpdateActionsEnglish } from "../i18n/locales/en-update-actions.ts";
import "../components/modal-dialog.ts";
import "../components/update-run-view.ts";
import { postNativeUpdate } from "./native-link-routing.ts";
import type { ConfirmAndStartUpdateParams, UpdateProgress } from "./update-confirmation.ts";
import { formatUpdateTargetLabel } from "./update-schedule-projection.ts";

registerUpdateActionsEnglish();

/** Bounds the wait for the request to be accepted before calling it a no-start. */
const UPDATE_ACCEPT_GRACE_MS = 4_000;
const UPDATE_DIALOG_OPEN_CLASS = "update-dialog-open";

type DialogPhase =
  | { kind: "confirm" }
  | { kind: "working"; connected: boolean }
  | { kind: "run"; run: UpdateRunRecord; connected: boolean; readError?: string | null }
  | { kind: "failed"; message: string };

let updateDialogOpen = false;

function formatInstalledAndAvailable(
  updateAvailable: UpdateAvailable | null,
  updateSchedule: UpdateScheduleState | null,
): string | undefined {
  const currentVersion = updateAvailable?.currentVersion?.trim();
  const installed = currentVersion
    ? t("updates.target.version", { version: currentVersion })
    : null;
  const available = formatUpdateTargetLabel(updateSchedule, updateAvailable);
  if (installed && available) {
    // A commit count already reads as a distance, so "Available 246 commits
    // behind" would double the framing; only a version needs the label.
    const behind =
      updateSchedule?.target?.kind === "git" || updateAvailable?.commitsBehind !== undefined;
    return t(behind ? "updates.confirm.versionsBehind" : "updates.confirm.versions", {
      available,
      installed,
    });
  }
  return installed ?? available ?? undefined;
}

function workingMessage(connected: boolean): string {
  // A disconnect alone does not prove a restart. Keep update recovery guidance
  // separate from flows that have an explicit restart result.
  return connected ? t("updates.dialog.installing") : t("updates.dialog.disconnected");
}

export async function confirmAndStartUpdateRuntime(
  params: ConfirmAndStartUpdateParams,
): Promise<void> {
  // Native confirms block reentrancy; refuse a second request rather than
  // stacking a dialog over an update that is already being reported.
  if (updateDialogOpen) {
    return;
  }
  const host = document.createElement("div");
  document.body.append(host);
  // One surface owns the outcome at a time: the ambient copy stays hidden while
  // the dialog that started this update is still reporting it.
  document.body.classList.add(UPDATE_DIALOG_OPEN_CLASS);
  const route = params.viaNativeApp
    ? {
        confirmLabel: t("updates.confirm.macAction"),
        message: t("updates.confirm.macMessage"),
        title: t("chat.sidebar.updateMacAndGateway"),
      }
    : {
        confirmLabel: t("updates.confirm.action"),
        message: t("updates.confirm.message"),
        title: t("chat.sidebar.updateGateway"),
      };
  const details = formatInstalledAndAvailable(params.updateAvailable, params.updateSchedule);
  await new Promise<void>((resolve) => {
    let phase: DialogPhase = params.existingRun
      ? { kind: "run", run: params.existingRun, connected: true }
      : { kind: "confirm" };
    let settled = false;
    let stopWatching: (() => void) | undefined;
    let acceptTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let sawBusy = false;

    const close = () => {
      if (settled) {
        return;
      }
      settled = true;
      stopWatching?.();
      if (acceptTimer !== undefined) {
        globalThis.clearTimeout(acceptTimer);
      }
      render(nothing, host);
      host.remove();
      document.body.classList.remove(UPDATE_DIALOG_OPEN_CLASS);
      updateDialogOpen = false;
      resolve();
    };
    const finish = () => {
      if (!settled && phase.kind === "run" && phase.run.status !== "running") {
        params.onAcknowledge?.();
      }
      close();
    };
    const watchProgress = (
      watch: NonNullable<ConfirmAndStartUpdateParams["watchUpdateProgress"]>,
      listener: (progress: UpdateProgress) => void,
    ) => {
      const stop = watch((progress) => {
        if (settled) {
          return;
        }
        // Restart retains the scoped row; its removal retires permission to display it.
        if (phase.kind === "run" && !progress.run) {
          close();
          return;
        }
        listener(progress);
      });
      // Subscribe may synchronously retire an existing row before returning its disposer.
      if (settled) {
        stop();
      } else {
        stopWatching = stop;
      }
    };
    updateDialogOpen = true;

    const draw = () => {
      if (settled) {
        return;
      }
      const current = phase;
      const run = current.kind === "run" ? current.run : null;
      const readError = current.kind === "run" ? current.readError : null;
      const working = current.kind === "working" || run?.status === "running";
      const failed =
        current.kind === "failed" ||
        (run !== null && run.status !== "running" && run.status !== "succeeded");
      const finished = run !== null && run.status !== "running";
      const body =
        current.kind === "run"
          ? (readError ?? "")
          : current.kind === "failed"
            ? current.message
            : current.kind === "working"
              ? workingMessage(current.connected)
              : `${route.message} ${t("updates.confirm.impact")}`;
      render(
        html`
          <openclaw-modal-dialog label=${route.title} description=${body} @modal-cancel=${finish}>
            <div class="exec-approval-card update-run-dialog">
              <div class="exec-approval-header">
                <div>
                  <div class="exec-approval-title">${route.title}</div>
                  <div class="exec-approval-sub" style="white-space: pre-line">${body}</div>
                </div>
              </div>
              ${
                details && current.kind === "confirm"
                  ? html`<div class="exec-approval-command mono">${details}</div>`
                  : nothing
              }
              ${
                current.kind === "run"
                  ? html`<openclaw-update-run-view
                      .run=${current.run}
                      .connected=${current.connected}
                    ></openclaw-update-run-view>`
                  : nothing
              }
              <div class="exec-approval-actions">
                ${
                  failed || finished || readError
                    ? html` ${(failed || readError) && params.onCheckStatus ? html`<button type="button" class="btn" @click=${() => void params.onCheckStatus?.()}>${t("updates.dialog.checkStatus")}</button>` : nothing}
                        ${
                          failed
                            ? html`<button
                                type="button"
                                class="btn primary"
                                @click=${() => {
                                  phase = { kind: "confirm" };
                                  stopWatching?.();
                                  draw();
                                }}
                              >
                                ${t("updates.dialog.retryUpdate")}
                              </button>`
                            : nothing
                        }
                        ${
                          failed && params.onReviewUpdate
                            ? html`<button
                                type="button"
                                class="btn"
                                @click=${() => {
                                  finish();
                                  params.onReviewUpdate?.();
                                }}
                              >
                                ${t("updates.reviewUpdate")}
                              </button>`
                            : nothing
                        }
                        <button type="button" class="btn" autofocus @click=${finish}>
                          ${t("common.close")}
                        </button>`
                    : html`
                        <button
                          type="button"
                          class="btn danger ${working ? "btn--busy" : ""}"
                          ?disabled=${working}
                          @click=${confirm}
                        >
                          ${
                            working
                              ? html`<span class="btn__spinner" aria-hidden="true"></span>${t(
                                    "chat.updating",
                                  )}`
                              : route.confirmLabel
                          }
                        </button>
                        <button type="button" class="btn" autofocus @click=${finish}>
                          ${working ? t("common.close") : t("common.cancel")}
                        </button>
                      `
                }
              </div>
            </div>
          </openclaw-modal-dialog>
        `,
        host,
      );
    };

    function confirm() {
      if (phase.kind !== "confirm") {
        return;
      }
      if (params.viaNativeApp && postNativeUpdate()) {
        finish();
        return;
      }
      const watch = params.watchUpdateProgress;
      if (!watch) {
        params.startGatewayUpdate();
        finish();
        return;
      }
      sawBusy = false;
      if (acceptTimer !== undefined) {
        globalThis.clearTimeout(acceptTimer);
      }
      phase = { kind: "working", connected: true };
      draw();
      // Start before subscribing: an accepted run clears the retained banner
      // synchronously, before its first await. Producers then emit that fresh
      // snapshot as the subscribe-time emit, so a failure still present on it
      // belongs to the previous attempt and is not this update's outcome —
      // a refused request is reported by the accept timer below instead.
      params.startGatewayUpdate();
      let retainedEmit = true;
      watchProgress(watch, (progress) => {
        const staleFailure = retainedEmit;
        retainedEmit = false;
        if (phase.kind === "confirm") {
          return;
        }
        if (progress.run && (!staleFailure || progress.run.status === "running")) {
          sawBusy = true;
          phase = {
            kind: "run",
            run: progress.run,
            connected: progress.connected,
            readError: progress.readError,
          };
          draw();
          return;
        }
        const failure = progress.failure ?? progress.readError;
        if (failure && !staleFailure) {
          phase = { kind: "failed", message: failure };
          draw();
          return;
        }
        sawBusy ||= progress.busy;
        phase = { kind: "working", connected: progress.connected };
        draw();
      });
      if (settled) {
        return;
      }
      acceptTimer = globalThis.setTimeout(() => {
        if (settled || sawBusy || phase.kind !== "working") {
          return;
        }
        phase = { kind: "failed", message: t("updates.dialog.notStarted") };
        draw();
      }, UPDATE_ACCEPT_GRACE_MS);
    }

    if (params.existingRun && params.watchUpdateProgress) {
      watchProgress(params.watchUpdateProgress, (progress) => {
        if (progress.run) {
          phase = {
            kind: "run",
            run: progress.run,
            connected: progress.connected,
            readError: progress.readError,
          };
          draw();
        }
      });
    }
    draw();
  });
}
