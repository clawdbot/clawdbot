import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import type { SkillsLibraryMutateParams } from "../../../../packages/gateway-protocol/src/index.ts";
import {
  renderSettingsEmpty,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import type { SkillLibraryController, LibraryView } from "./library-controller.ts";
import { renderLibraryIdentity } from "./library-detail.ts";
import { libraryEventControl } from "./library-events.ts";
import { libraryFileText } from "./library-files.ts";

export function renderSkillLibrary(library: SkillLibraryController) {
  const list = library.list;
  const options: Array<{ value: LibraryView; label: string }> = [];
  const hasLibraries = Boolean(list?.entries.length);
  if (list?.multipleProfiles || hasLibraries || list?.defaultTarget === "personal") {
    if (list?.profileId) {
      options.push({ value: "mine", label: t("skillLibrary.mine") });
    }
    if (
      list?.multipleProfiles ||
      list?.entries.some((entry) => entry.shared || entry.ownerProfileId === null)
    ) {
      options.push({ value: "team", label: t("skillLibrary.team") });
    }
    options.push(
      { value: "all", label: t("skillLibrary.all") },
      { value: "workspace", label: t("skillLibrary.inventory") },
    );
  }
  const query = library.query.toLowerCase().trim();
  const entries = (list?.entries ?? []).filter((entry) => {
    const scopeMatches =
      library.view === "mine"
        ? entry.ownerProfileId === list?.profileId
        : library.view === "team"
          ? entry.shared || entry.ownerProfileId === null
          : true;
    return (
      scopeMatches &&
      (!query ||
        `${entry.slug} ${entry.name} ${entry.description} ${entry.ownerLabel}`
          .toLowerCase()
          .includes(query))
    );
  });
  return html`
    <div class="plugins-toolbar">
      ${options.length > 0
        ? renderSettingsSegmented({
            value: library.view ?? "workspace",
            ariaLabel: t("skillLibrary.library"),
            options,
            onChange: (view) => {
              library.view = view;
              library.changed();
            },
          })
        : nothing}
      <button
        type="button"
        class="btn"
        ?disabled=${!library.canCreate || library.busy}
        @click=${() => library.create()}
      >
        ${t("skillLibrary.create")}
      </button>
      <button
        type="button"
        class="btn"
        ?disabled=${!library.canCreate || library.busy}
        @click=${() => {
          library.importOpen = true;
          library.importSource = null;
          library.changed();
        }}
      >
        ${t("skillLibrary.import")}
      </button>
      ${!library.showWorkspace
        ? html`<button
            type="button"
            class="btn"
            ?disabled=${library.loading || library.busy}
            @click=${() => void library.load()}
          >
            ${t("common.refresh")}
          </button>`
        : nothing}
    </div>
    ${list?.defaultTarget === "unavailable"
      ? html`<p class="muted">${t("skillLibrary.signIn")}</p>`
      : nothing}
    ${library.error && !library.draft && !library.importOpen
      ? html`<div class="callout danger" role="alert">${library.error}</div>`
      : nothing}
    ${library.notice && !library.draft
      ? html`<div class="callout success" role="status">${library.notice}</div>`
      : nothing}
    ${list && !library.showWorkspace
      ? html`<p class="muted">
            ${t("skillLibrary.defaultLimit", { count: String(list.defaultSelectionLimit) })}
          </p>
          ${list.defaultSelectionNotice
            ? html`<p class="callout" role="status">${list.defaultSelectionNotice}</p>`
            : nothing}`
      : nothing}
    ${!library.showWorkspace
      ? html`
          <label class="field"
            ><span>${t("common.search")}</span
            ><input
              class="settings-input"
              name="library-search"
              .value=${library.query}
              placeholder=${t("skillLibrary.search")}
              @input=${(event: Event) => {
                library.query = libraryEventControl(event, HTMLInputElement).value;
                library.changed();
              }}
          /></label>
          ${library.loading
            ? html`<p role="status">${t("common.loading")}</p>`
            : renderSettingsSection(
                { title: t(`skillLibrary.${library.view}`), count: entries.length },
                entries.length === 0
                  ? renderSettingsEmpty(t("skillLibrary.empty"))
                  : repeat(
                      entries,
                      (entry) => entry.skillId,
                      (entry) => html` <div class="settings-row">
                        <button
                          type="button"
                          class="settings-row__text plugins-item__detail-button"
                          ?disabled=${library.loading || library.busy}
                          @click=${() => void library.open(entry.skillId)}
                        >
                          <span class="settings-row__title">${entry.slug}</span>
                          <span class="settings-row__desc">${entry.description}</span>
                          <span class="settings-row__desc"
                            >${entry.ownerLabel} ·
                            ${entry.shared ? t("skillLibrary.shared") : t("skillLibrary.private")} ·
                            ${entry.revision.slice(0, 8)}</span
                          >
                        </button>
                        <div class="settings-row__control">
                          ${renderSettingsStatus({
                            kind: entry.enabled ? "ok" : "muted",
                            label: t(entry.enabled ? "skillsPage.enabled" : "skillsPage.disabled"),
                          })}
                        </div>
                      </div>`,
                    ),
              )}
        `
      : nothing}
    ${renderLibraryEditor(library)} ${renderLibraryImport(library)}
  `;
}

function renderLibraryEditor(library: SkillLibraryController) {
  const draft = library.draft;
  if (!draft) {
    return nothing;
  }
  const pending = draft.proposal !== null;
  const disabled = !library.canEdit || library.busy || library.loading || pending;
  const support = draft.files.find((file) => file.path === draft.selectedFile);
  const text =
    draft.selectedFile === "SKILL.md" ? draft.content : support ? libraryFileText(support) : null;
  const changeText = (value: string) => {
    if (disabled) {
      return;
    }
    if (draft.selectedFile === "SKILL.md") {
      draft.content = value;
    } else {
      draft.files = draft.files.map((file) =>
        file.path === draft.selectedFile ? { ...file, content: value, encoding: "utf8" } : file,
      );
    }
    draft.dirty = true;
    library.changed();
  };
  const mutationLocked = disabled || draft.dirty;
  const mutationButton = (action: SkillsLibraryMutateParams["action"], locked = mutationLocked) =>
    html`<button
      type="button"
      class=${action === "remove" ? "btn danger" : "btn"}
      ?disabled=${locked}
      @click=${() => void library.mutate(action)}
    >
      ${t(`skillLibrary.${action}`)}
    </button>`;
  return html` <openclaw-modal-dialog
    label=${draft.entry?.slug ?? t("skillLibrary.create")}
    style="--openclaw-modal-width: 960px;"
    @modal-cancel=${(event: Event) => {
      // Native dismissal must not bypass the controller's busy and discard checks.
      event.preventDefault();
      library.close();
    }}
  >
    <form
      class="md-preview-dialog__panel"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void library.save();
      }}
      @keydown=${(event: KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !disabled) {
          event.preventDefault();
          libraryEventControl(event, HTMLFormElement).requestSubmit();
        }
      }}
    >
      <div class="md-preview-dialog__header">
        <strong>${draft.entry?.slug ?? t("skillLibrary.create")}</strong
        ><button
          type="button"
          class="btn btn--sm"
          ?disabled=${library.busy}
          @click=${() => library.close()}
        >
          ${t("common.close")}
        </button>
      </div>
      <div
        class="md-preview-dialog__body"
        style="display: grid; gap: var(--space-4); min-width: 0;"
      >
        <p class="muted">
          ${draft.target === "workspace"
            ? t("skillLibrary.workspaceTarget", { agent: draft.agentId ?? "" })
            : draft.entry
              ? t("skillLibrary.ownerRevision", {
                  owner: draft.entry.ownerLabel,
                  revision: draft.entry.revision.slice(0, 8),
                })
              : t("skillLibrary.personalTarget")}
        </p>
        ${draft.entry ? renderLibraryIdentity(draft.entry) : nothing}
        ${!library.canEdit ? html`<p role="status">${t("skillLibrary.readOnly")}</p>` : nothing}
        <label class="field"
          ><span>${t("skillLibrary.slug")}</span
          ><input
            class="settings-input"
            name="library-slug"
            required
            pattern="[a-z0-9][a-z0-9-]{0,62}"
            maxlength="63"
            ?disabled=${disabled}
            .value=${live(draft.slug)}
            @input=${(event: Event) => {
              draft.slug = libraryEventControl(event, HTMLInputElement).value;
              draft.dirty = true;
              library.changed();
            }}
        /></label>
        ${draft.target === "workspace"
          ? html`<label class="field"
              ><span>${t("skillLibrary.description")}</span
              ><input
                class="settings-input"
                name="library-description"
                required
                ?disabled=${disabled}
                .value=${draft.description}
                @input=${(event: Event) => {
                  draft.description = libraryEventControl(event, HTMLInputElement).value;
                  draft.dirty = true;
                  library.changed();
                }}
            /></label>`
          : nothing}
        <div class="plugins-toolbar">
          <label class="field" style="min-width: 0; flex: 1;"
            ><span>${t("skillLibrary.file")}</span
            ><select
              class="settings-select"
              aria-label=${t("skillLibrary.file")}
              .value=${draft.selectedFile}
              @change=${(event: Event) => {
                draft.selectedFile = libraryEventControl(event, HTMLSelectElement).value;
                library.changed();
              }}
            >
              <option value="SKILL.md" ?selected=${draft.selectedFile === "SKILL.md"}>
                SKILL.md
              </option>
              ${draft.files.map(
                (file) =>
                  // select.value commits before this child part inserts a newly added option.
                  html`<option value=${file.path} ?selected=${draft.selectedFile === file.path}>
                    ${file.path}${file.executable ? " *" : ""}
                  </option>`,
              )}
            </select></label
          >
          ${support && library.canEdit
            ? html`<button
                type="button"
                class="btn"
                ?disabled=${disabled}
                @click=${() => {
                  if (
                    !window.confirm(t("skillLibrary.deleteFileConfirm", { path: support.path }))
                  ) {
                    return;
                  }
                  draft.files = draft.files.filter((file) => file.path !== support.path);
                  draft.selectedFile = "SKILL.md";
                  draft.dirty = true;
                  library.changed();
                }}
              >
                ${t("skillLibrary.deleteFile")}
              </button>`
            : nothing}
        </div>
        ${support && library.canEdit
          ? html`<label class="field checkbox"
              ><input
                type="checkbox"
                name="library-file-executable"
                ?disabled=${disabled}
                .checked=${support.executable === true}
                @change=${(event: Event) => {
                  const executable = libraryEventControl(event, HTMLInputElement).checked;
                  draft.files = draft.files.map((file) =>
                    file.path === support.path ? { ...file, executable } : file,
                  );
                  draft.dirty = true;
                  library.changed();
                }}
              /><span>${t("skillLibrary.executable")}</span></label
            >`
          : nothing}
        ${text === null
          ? html`<p class="muted">${t("skillLibrary.binary")}</p>`
          : html`<label class="field"
              ><span>${draft.selectedFile}</span
              ><textarea
                name="library-content"
                class="settings-input"
                spellcheck="false"
                rows="18"
                style="font-family: var(--mono); min-width: 0; max-width: 100%; box-sizing: border-box; resize: vertical;"
                ?readonly=${disabled}
                .value=${live(text)}
                @input=${(event: Event) =>
                  changeText(libraryEventControl(event, HTMLTextAreaElement).value)}
              ></textarea>
            </label>`}
        ${!disabled
          ? html`<div class="plugins-toolbar">
              <label class="field" style="flex: 1; min-width: 0;"
                ><span>${t("skillLibrary.newFile")}</span
                ><input
                  class="settings-input"
                  name="library-file-path"
                  .value=${library.newFilePath}
                  @input=${(event: Event) => {
                    library.newFilePath = libraryEventControl(event, HTMLInputElement).value;
                    library.changed();
                  }} /></label
              ><button
                type="button"
                class="btn"
                ?disabled=${!library.newFilePath.trim()}
                @click=${() => {
                  const path = library.newFilePath.trim();
                  if (path === "SKILL.md" || draft.files.some((file) => file.path === path)) {
                    library.error = t("skillLibrary.fileExists");
                  } else {
                    draft.files = [...draft.files, { path, content: "", encoding: "utf8" }];
                    draft.selectedFile = path;
                    draft.dirty = true;
                    library.newFilePath = "";
                  }
                  library.changed();
                }}
              >
                ${t("skillLibrary.addFile")}
              </button>
            </div>`
          : nothing}
        ${library.error
          ? html`<div class="callout danger" role="alert">${library.error}</div>`
          : nothing}
        ${library.notice
          ? html`<div class="callout success" role="status">${library.notice}</div>`
          : nothing}
        <div class="plugins-toolbar">
          ${!library.canEdit
            ? nothing
            : pending
              ? html`<button
                  type="button"
                  class="btn primary"
                  ?disabled=${library.busy}
                  @click=${() => void library.applyWorkspace()}
                >
                  ${t("skillLibrary.apply")}
                </button>`
              : html`<button
                  type="submit"
                  class="btn primary"
                  ?disabled=${disabled || !draft.dirty || !draft.content.trim()}
                >
                  ${library.busy
                    ? t("common.loading")
                    : draft.target === "workspace"
                      ? t("skillLibrary.propose")
                      : t("skillLibrary.save")}
                </button>`}
          ${library.canEdit && draft.entry
            ? html`
                ${mutationButton(draft.entry.enabled ? "disable" : "enable")}
                ${draft.entry.ownerProfileId
                  ? mutationButton(draft.entry.shared ? "unshare" : "share")
                  : nothing}
              `
            : nothing}
        </div>
        ${library.canEdit && draft.entry && draft.revisions.length > 1
          ? html`<div class="plugins-toolbar">
              <label class="field" style="flex: 1; min-width: 0;"
                ><span>${t("skillLibrary.revision")}</span
                ><select
                  class="settings-select"
                  aria-label=${t("skillLibrary.revision")}
                  .value=${draft.rollbackRevision}
                  ?disabled=${mutationLocked}
                  @change=${(event: Event) => {
                    draft.rollbackRevision = libraryEventControl(event, HTMLSelectElement).value;
                    library.changed();
                  }}
                >
                  <option value="" ?selected=${draft.rollbackRevision === ""}>
                    ${t("skillLibrary.selectRevision")}
                  </option>
                  ${draft.revisions
                    .filter((revision) => revision.revision !== draft.entry?.revision)
                    .map(
                      (revision) =>
                        html`<option
                          value=${revision.revision}
                          ?selected=${draft.rollbackRevision === revision.revision}
                        >
                          ${new Date(revision.createdAt).toLocaleString()} ·
                          ${revision.revision.slice(0, 8)}
                        </option>`,
                    )}
                </select></label
              >${mutationButton("rollback", mutationLocked || !draft.rollbackRevision)}
            </div>`
          : nothing}
        ${library.canEdit && draft.entry
          ? html`<div
              class="plugins-toolbar"
              style="border-top: 1px solid var(--border); padding-top: var(--space-4);"
            >
              ${library.canTransfer && draft.entry.ownerProfileId
                ? mutationButton("transfer")
                : nothing}
              ${mutationButton("remove")}
            </div>`
          : nothing}
      </div>
    </form>
  </openclaw-modal-dialog>`;
}

function renderLibraryImport(library: SkillLibraryController) {
  if (!library.importOpen) {
    return nothing;
  }
  const close = () => library.close();
  return html`<openclaw-modal-dialog
    label=${t("skillLibrary.import")}
    @modal-cancel=${(event: Event) => {
      event.preventDefault();
      close();
    }}
  >
    <form
      class="md-preview-dialog__panel"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        if (library.importSource) {
          void library.importClawHub(
            library.importSlug,
            library.importSource.slug,
            library.importSource.version,
          );
        } else {
          void library.importFiles(library.importSelection);
        }
      }}
    >
      <div class="md-preview-dialog__header">
        <strong>${t("skillLibrary.import")}</strong
        ><button type="button" class="btn btn--sm" ?disabled=${library.busy} @click=${close}>
          ${t("common.close")}
        </button>
      </div>
      <div
        class="md-preview-dialog__body"
        style="display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4);"
      >
        <p class="muted">
          ${library.importSource
            ? t("skillLibrary.importClawHub", { source: library.importSource.slug })
            : library.createTarget === "workspace"
              ? t("skillLibrary.importWorkspace")
              : t("skillLibrary.importHelp")}
        </p>
        <label class="field"
          ><span>${t("skillLibrary.slug")}</span
          ><input
            class="settings-input"
            required
            name="library-import-slug"
            pattern="[a-z0-9][a-z0-9-]{0,62}"
            .value=${library.importSlug}
            ?disabled=${library.busy}
            @input=${(event: Event) => {
              library.importSlug = libraryEventControl(event, HTMLInputElement).value;
              library.changed();
            }}
        /></label>
        ${!library.importSource
          ? [false, true].map(
              (directory) => html`<label class="field"
                ><span
                  >${t(directory ? "skillLibrary.chooseFolder" : "skillLibrary.chooseFiles")}</span
                ><input
                  type="file"
                  style="min-width: 0;"
                  ?webkitdirectory=${directory}
                  multiple
                  name=${directory ? "library-import-directory" : "library-import-files"}
                  ?disabled=${library.busy}
                  @change=${(event: Event) => {
                    library.importSelection = Array.from(
                      libraryEventControl(event, HTMLInputElement).files ?? [],
                    );
                    library.changed();
                  }}
              /></label>`,
            )
          : nothing}
        ${library.error
          ? html`<div class="callout danger" role="alert">${library.error}</div>`
          : nothing}
        <button
          type="submit"
          class="btn primary"
          ?disabled=${library.busy ||
          (!library.importSource && library.importSelection.length === 0)}
        >
          ${library.busy ? t("common.loading") : t("skillLibrary.import")}
        </button>
      </div>
    </form>
  </openclaw-modal-dialog>`;
}
