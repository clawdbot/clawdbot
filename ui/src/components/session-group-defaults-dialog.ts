import { html, nothing, render } from "lit";
import { t } from "../i18n/index.ts";
import "./modal-dialog.ts";

export type SessionGroupDefaults = { cwd: string; worktree: boolean };

type Options = {
  group: string;
  defaults: SessionGroupDefaults;
  submit: (defaults: SessionGroupDefaults) => Promise<string | null>;
};

let active = false;

export function showSessionGroupDefaultsDialog(options: Options): Promise<void> {
  if (active) {
    return Promise.resolve();
  }
  active = true;
  const host = document.createElement("div");
  document.body.append(host);
  return new Promise<void>((resolve) => {
    let submitting = false;
    let failure: string | null = null;

    const finish = () => {
      render(nothing, host);
      host.remove();
      active = false;
      resolve();
    };

    const handleSubmit = async (event: Event) => {
      event.preventDefault();
      if (submitting) {
        return;
      }
      const form = event.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      submitting = true;
      failure = null;
      paint();
      try {
        failure = await options.submit({
          cwd: String(data.get("cwd") ?? "").trim(),
          worktree: data.get("mode") === "worktree",
        });
      } catch (error) {
        failure = String(error);
      }
      if (!failure) {
        finish();
        return;
      }
      submitting = false;
      paint();
    };

    function paint() {
      render(
        html`
          <openclaw-modal-dialog
            label=${t("sessionsView.groupDefaultsTitle", { group: options.group })}
            @modal-cancel=${(event: Event) => {
              if (submitting) {
                event.preventDefault();
                return;
              }
              finish();
            }}
          >
            <form class="exec-approval-card" @submit=${handleSubmit}>
              <div class="exec-approval-header">
                <div class="exec-approval-title">
                  ${t("sessionsView.groupDefaultsTitle", { group: options.group })}
                </div>
              </div>
              <label class="field">
                <span>${t("sessionsView.groupDefaultsCwd")}</span>
                <input
                  name="cwd"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  .value=${options.defaults.cwd}
                  placeholder=${t("sessionsView.groupDefaultsCwdPlaceholder")}
                  ?disabled=${submitting}
                  autofocus
                />
                <span class="muted">${t("sessionsView.groupDefaultsCwdHint")}</span>
              </label>
              <label class="field">
                <span>${t("sessionsView.groupDefaultsMode")}</span>
                <select name="mode" ?disabled=${submitting}>
                  <option value="local" ?selected=${!options.defaults.worktree}>
                    ${t("sessionsView.groupDefaultsLocal")}
                  </option>
                  <option value="worktree" ?selected=${options.defaults.worktree}>
                    ${t("sessionsView.groupDefaultsWorktree")}
                  </option>
                </select>
              </label>
              ${failure
                ? html`<div class="exec-approval-error" role="alert">${failure}</div>`
                : nothing}
              <div class="exec-approval-actions">
                <button type="submit" class="btn primary" ?disabled=${submitting}>
                  ${t("common.save")}
                </button>
                <button type="button" class="btn" ?disabled=${submitting} @click=${finish}>
                  ${t("common.cancel")}
                </button>
              </div>
            </form>
          </openclaw-modal-dialog>
        `,
        host,
      );
    }

    paint();
  });
}
