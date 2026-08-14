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
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import "../components/modal-dialog.ts";
import { postNativeUpdate } from "./native-link-routing.ts";
import type { ConfirmAndStartUpdateParams, UpdateProgress } from "./update-confirmation.ts";
import { formatUpdateTargetLabel } from "./update-overlay-helpers.ts";

/** Bounds the wait for the request to be accepted before calling it a no-start. */
const UPDATE_ACCEPT_GRACE_MS = 4_000;
const UPDATE_DIALOG_OPEN_CLASS = "update-dialog-open";

type DialogPhase =
  | { kind: "confirm" }
  | { kind: "working"; connected: boolean }
  | { kind: "failed"; message: string };

let updateDialogActive = false;

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
  // The restart is the loud part of the wait; name it while it is happening
  // instead of leaving the operator to interpret a frozen page.
  return connected ? t("updates.dialog.installing") : t("updates.dialog.restarting");
}

export async function confirmAndStartUpdateRuntime(
  params: ConfirmAndStartUpdateParams,
): Promise<void> {
  // Native confirms block reentrancy; refuse a second request rather than
  // stacking a dialog over an update that is already being reported.
  if (updateDialogActive) {
    return;
  }
  updateDialogActive = true;
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
    let phase: DialogPhase = { kind: "confirm" };
    let settled = false;
    let stopWatching: (() => void) | undefined;
    let acceptTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let sawBusy = false;

    const finish = () => {
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
      updateDialogActive = false;
      resolve();
    };

    const draw = () => {
      if (settled) {
        return;
      }
      const current = phase;
      const working = current.kind === "working";
      const failed = current.kind === "failed";
      const body =
        current.kind === "failed"
          ? current.message
          : current.kind === "working"
            ? workingMessage(current.connected)
            : `${route.message} ${t("updates.confirm.impact")}`;
      render(
        html`
          <openclaw-modal-dialog label=${route.title} description=${body} @modal-cancel=${finish}>
            <div class="exec-approval-card">
              <div class="exec-approval-header">
                <div>
                  <div class="exec-approval-title">${route.title}</div>
                  <div class="exec-approval-sub" style="white-space: pre-line">${body}</div>
                </div>
              </div>
              ${details && !failed
                ? html`<div class="exec-approval-command mono">${details}</div>`
                : nothing}
              <div class="exec-approval-actions">
                ${failed
                  ? html`<button type="button" class="btn" autofocus @click=${finish}>
                      ${t("common.close")}
                    </button>`
                  : html`
                      <button
                        type="button"
                        class="btn danger ${working ? "btn--busy" : ""}"
                        ?disabled=${working}
                        @click=${confirm}
                      >
                        ${working
                          ? html`<span class="btn__spinner" aria-hidden="true"></span>${t(
                                "chat.updating",
                              )}`
                          : route.confirmLabel}
                      </button>
                      <button type="button" class="btn" autofocus @click=${finish}>
                        ${working ? t("common.close") : t("common.cancel")}
                      </button>
                    `}
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
      phase = { kind: "working", connected: true };
      draw();
      // Start before subscribing: an accepted run clears the retained banner
      // synchronously, before its first await. Producers then emit that fresh
      // snapshot as the subscribe-time emit, so a failure still present on it
      // belongs to the previous attempt and is not this update's outcome —
      // a refused request is reported by the accept timer below instead.
      params.startGatewayUpdate();
      let retainedEmit = true;
      stopWatching = watch((progress: UpdateProgress) => {
        const staleFailure = retainedEmit;
        retainedEmit = false;
        if (settled || phase.kind === "confirm") {
          return;
        }
        if (progress.failure && !staleFailure) {
          phase = { kind: "failed", message: progress.failure };
          draw();
          return;
        }
        if (progress.busy) {
          sawBusy = true;
        } else if (sawBusy) {
          // Finished without a failure: the outcome is a toast, or a reload
          // that replays it. Nothing left for the dialog to say.
          finish();
          return;
        }
        phase = { kind: "working", connected: progress.connected };
        draw();
      });
      acceptTimer = globalThis.setTimeout(() => {
        if (settled || sawBusy || phase.kind !== "working") {
          return;
        }
        phase = { kind: "failed", message: t("updates.dialog.notStarted") };
        draw();
      }, UPDATE_ACCEPT_GRACE_MS);
    }

    draw();
  });
}
