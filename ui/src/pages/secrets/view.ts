import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { SecretStoreEntry } from "../../../../packages/gateway-protocol/src/index.js";
import { icon } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import {
  renderDocsLink,
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import "../../components/web-awesome.ts";
import { i18n, t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import type { SecretsStoreDraft } from "../../lib/secrets-store/index.ts";
import "../../styles/secrets-store.css";

export type SecretsDialogMode = "add" | "edit" | null;

type SecretsStoreViewProps = {
  entries: SecretStoreEntry[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  canList: boolean;
  canSet: boolean;
  canDelete: boolean;
  dialogMode: SecretsDialogMode;
  draft: SecretsStoreDraft;
  formError: string | null;
  bulkOpen: boolean;
  bulkRaw: string;
  bulkAutoDetect: boolean;
  bulkSecretCount: number;
  bulkEntryCount: number;
  bulkInvalidNames: readonly string[];
  onRefresh: () => void;
  onOpenAdd: () => void;
  onOpenEdit: (entry: SecretStoreEntry) => void;
  onCloseDialog: () => void;
  onDraftNameChange: (name: string) => void;
  onDraftValueChange: (value: string) => void;
  onDraftSecretChange: (secret: boolean) => void;
  onSubmitDraft: () => void;
  onOpenBulk: () => void;
  onCloseBulk: () => void;
  onBulkRawChange: (raw: string) => void;
  onBulkAutoDetectChange: (enabled: boolean) => void;
  onSubmitBulk: () => void;
  onDelete: (entry: SecretStoreEntry) => void;
};

const DOCS_URL = "https://docs.openclaw.ai/gateway/secrets#shared-secret-store";
const SECRET_MASK = "••••••••";

function updatedLabel(entry: SecretStoreEntry): string {
  const relative = formatRelativeTimestamp(entry.updatedAtMs, { fallback: t("common.unknown") });
  return entry.updatedBy
    ? t("secretsStore.updatedBy", { time: relative, name: entry.updatedBy })
    : relative;
}

function renderEntryMenu(props: SecretsStoreViewProps, entry: SecretStoreEntry): TemplateResult {
  if (!props.canSet && !props.canDelete) {
    return html``;
  }
  return html`
    <wa-dropdown
      class="secrets-store__menu"
      placement="bottom-end"
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
        if (event.detail.item.value === "edit" && props.canSet) {
          props.onOpenEdit(entry);
        } else if (event.detail.item.value === "delete" && props.canDelete) {
          props.onDelete(entry);
        }
      }}
    >
      <button
        slot="trigger"
        type="button"
        class="btn btn--sm btn--ghost secrets-store__menu-trigger"
        aria-label=${t("secretsStore.actionsFor", { name: entry.name })}
        title=${t("secretsStore.actions")}
        ?disabled=${props.busy}
      >
        ${icon("moreHorizontal")}
      </button>
      ${props.canSet
        ? html`<wa-dropdown-item value="edit">${t("secretsStore.edit")}</wa-dropdown-item>`
        : nothing}
      ${props.canDelete
        ? html`<wa-dropdown-item value="delete" variant="danger"
            >${t("common.delete")}</wa-dropdown-item
          >`
        : nothing}
    </wa-dropdown>
  `;
}

function renderTable(props: SecretsStoreViewProps): TemplateResult {
  if (!props.canList) {
    return renderSettingsEmpty(t("secretsStore.unavailable"));
  }
  if (props.loading && !props.entries.length) {
    return renderSettingsEmpty(t("common.loading"));
  }
  if (!props.entries.length) {
    return html`
      <div class="secrets-store__empty">
        ${renderSettingsEmpty(t("secretsStore.empty"))}
        <p>${t("secretsStore.emptyHint")}</p>
        ${renderDocsLink(DOCS_URL, t("secretsStore.readDocs"))}
      </div>
    `;
  }
  return html`
    <div class="secrets-store__table-wrap">
      <table class="secrets-store__table">
        <thead>
          <tr>
            <th scope="col">${t("secretsStore.name")}</th>
            <th scope="col">${t("secretsStore.value")}</th>
            <th scope="col">${t("secretsStore.lastUpdated")}</th>
            <th scope="col" class="secrets-store__actions-heading">
              <span class="settings-control__sr-label">${t("secretsStore.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          ${repeat(
            props.entries,
            (entry) => entry.name,
            (entry) => html`
              <tr tabindex="0" aria-label=${entry.name}>
                <td><code class="secrets-store__name">${entry.name}</code></td>
                <td>
                  <span
                    class="secrets-store__value ${entry.kind === "secret"
                      ? "secrets-store__value--secret"
                      : ""}"
                    title=${entry.kind === "env" ? entry.value : nothing}
                    >${entry.kind === "env" ? entry.value : SECRET_MASK}</span
                  >
                </td>
                <td>
                  <time
                    class="secrets-store__updated"
                    datetime=${new Date(entry.updatedAtMs).toISOString()}
                    title=${new Intl.DateTimeFormat(i18n.getLocale(), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(entry.updatedAtMs))}
                    >${updatedLabel(entry)}</time
                  >
                </td>
                <td class="secrets-store__actions-cell">${renderEntryMenu(props, entry)}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

function renderEntryDialog(props: SecretsStoreViewProps): TemplateResult | typeof nothing {
  if (!props.dialogMode) {
    return nothing;
  }
  const editing = props.dialogMode === "edit";
  return html`
    <openclaw-modal-dialog
      label=${editing ? t("secretsStore.editTitle") : t("secretsStore.addTitle")}
      description=${t("secretsStore.secretHint")}
      @modal-cancel=${props.onCloseDialog}
    >
      <form
        class="secrets-store-dialog"
        aria-busy=${props.busy ? "true" : "false"}
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          props.onSubmitDraft();
        }}
      >
        <div class="secrets-store-dialog__header">
          <h2>${editing ? t("secretsStore.editTitle") : t("secretsStore.addTitle")}</h2>
          <p>
            ${editing && props.draft.kind === "secret"
              ? t("secretsStore.replaceHint")
              : t("secretsStore.secretHint")}
          </p>
        </div>
        <label class="secrets-store-field">
          <span>${t("secretsStore.name")}</span>
          <input
            class="settings-input mono"
            name="name"
            autocomplete="off"
            spellcheck="false"
            autofocus
            ?readonly=${editing}
            ?disabled=${props.busy}
            .value=${props.draft.name}
            @input=${(event: Event) =>
              props.onDraftNameChange((event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label class="secrets-store-field">
          <span>${t("secretsStore.value")}</span>
          <textarea
            class="settings-input secrets-store-dialog__value"
            name="value"
            autocomplete="off"
            spellcheck="false"
            ?disabled=${props.busy}
            .value=${props.draft.value}
            @input=${(event: Event) =>
              props.onDraftValueChange((event.currentTarget as HTMLTextAreaElement).value)}
          ></textarea>
        </label>
        <label class="secrets-store-checkbox">
          <input
            type="checkbox"
            .checked=${props.draft.kind === "secret"}
            ?disabled=${props.busy}
            @change=${(event: Event) =>
              props.onDraftSecretChange((event.currentTarget as HTMLInputElement).checked)}
          />
          <span>
            <strong>${t("secretsStore.secret")}</strong>
            <small>${t("secretsStore.secretHint")}</small>
          </span>
        </label>
        ${props.formError
          ? html`<div class="callout danger" role="alert">${props.formError}</div>`
          : nothing}
        <div class="secrets-store-dialog__actions">
          <button class="btn primary" type="submit" ?disabled=${props.busy}>
            ${props.busy ? t("common.saving") : t("common.save")}
          </button>
          <button class="btn" type="button" ?disabled=${props.busy} @click=${props.onCloseDialog}>
            ${t("common.cancel")}
          </button>
        </div>
      </form>
    </openclaw-modal-dialog>
  `;
}

function renderBulkDialog(props: SecretsStoreViewProps): TemplateResult | typeof nothing {
  if (!props.bulkOpen) {
    return nothing;
  }
  return html`
    <openclaw-modal-dialog
      label=${t("secretsStore.bulkTitle")}
      description=${t("secretsStore.bulkHint")}
      @modal-cancel=${props.onCloseBulk}
    >
      <form
        class="secrets-store-dialog"
        aria-busy=${props.busy ? "true" : "false"}
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          props.onSubmitBulk();
        }}
      >
        <div class="secrets-store-dialog__header">
          <h2>${t("secretsStore.bulkTitle")}</h2>
          <p>${t("secretsStore.bulkHint")}</p>
        </div>
        <label class="secrets-store-field">
          <span>${t("secretsStore.bulkValues")}</span>
          <textarea
            class="settings-input secrets-store-dialog__bulk"
            name="bulk-values"
            placeholder=${t("secretsStore.bulkPlaceholder")}
            autocomplete="off"
            spellcheck="false"
            autofocus
            ?disabled=${props.busy}
            .value=${props.bulkRaw}
            @input=${(event: Event) =>
              props.onBulkRawChange((event.currentTarget as HTMLTextAreaElement).value)}
          ></textarea>
        </label>
        <div class="secrets-store-bulk__summary" aria-live="polite">
          ${t("secretsStore.secretCount", { count: String(props.bulkSecretCount) })}
          <span>${t("secretsStore.entryCount", { count: String(props.bulkEntryCount) })}</span>
        </div>
        <label class="secrets-store-checkbox">
          <input
            type="checkbox"
            .checked=${props.bulkAutoDetect}
            ?disabled=${props.busy}
            @change=${(event: Event) =>
              props.onBulkAutoDetectChange((event.currentTarget as HTMLInputElement).checked)}
          />
          <span>
            <strong>${t("secretsStore.autoDetect")}</strong>
            <small>${t("secretsStore.autoDetectHint")}</small>
          </span>
        </label>
        ${props.bulkInvalidNames.length
          ? html`<div class="callout danger" role="alert">
              ${t("secretsStore.invalidNames", { names: props.bulkInvalidNames.join(", ") })}
            </div>`
          : nothing}
        ${props.formError
          ? html`<div class="callout danger" role="alert">${props.formError}</div>`
          : nothing}
        <div class="secrets-store-dialog__actions">
          <button
            class="btn primary"
            type="submit"
            ?disabled=${props.busy || !props.bulkEntryCount || props.bulkInvalidNames.length > 0}
          >
            ${props.busy ? t("common.saving") : t("secretsStore.bulkSave")}
          </button>
          <button class="btn" type="button" ?disabled=${props.busy} @click=${props.onCloseBulk}>
            ${t("common.cancel")}
          </button>
        </div>
      </form>
    </openclaw-modal-dialog>
  `;
}

export function renderSecretsStore(props: SecretsStoreViewProps): TemplateResult {
  const actions = props.canSet
    ? html`
        <button
          class="btn btn--sm"
          type="button"
          ?disabled=${props.busy}
          @click=${props.onOpenBulk}
        >
          ${t("secretsStore.bulkAdd")}
        </button>
        <button
          class="btn btn--sm primary"
          type="button"
          ?disabled=${props.busy}
          @click=${props.onOpenAdd}
        >
          ${icon("plus")} ${t("secretsStore.add")}
        </button>
      `
    : undefined;
  return html`
    ${renderSettingsPage(
      html`
        ${props.error
          ? html`<div class="callout danger secrets-store__message" role="alert">
              <span>${props.error}</span>
              ${props.canList
                ? html`<button class="btn btn--sm" type="button" @click=${props.onRefresh}>
                    ${t("common.retry")}
                  </button>`
                : nothing}
            </div>`
          : nothing}
        ${props.notice
          ? html`<div
              class="callout success secrets-store__message"
              role="status"
              aria-live="polite"
            >
              ${props.notice}
            </div>`
          : nothing}
        ${renderSettingsSection(
          {
            title: t("secretsStore.teamTitle"),
            description: t("secretsStore.teamDescription"),
            actions,
            count: props.entries.length,
          },
          renderTable(props),
        )}
      `,
      { wide: true, intro: t("secretsStore.intro") },
    )}
    ${renderEntryDialog(props)} ${renderBulkDialog(props)}
  `;
}
