import { html } from "lit";
import type {
  SkillLibraryEntry,
  SkillsLibraryReadResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { t } from "../../i18n/index.ts";
import { libraryEventControl } from "./library-events.ts";
import { libraryFileText } from "./library-files.ts";
import "../../components/modal-dialog.ts";

export function renderLibraryIdentity(
  entry: Pick<SkillLibraryEntry, "skillId" | "revision" | "name">,
) {
  return html`<details class="muted" style="overflow-wrap: anywhere; min-width: 0;">
    <summary>${t("skillLibrary.technicalDetails")}</summary>
    <dl>
      <dt>${t("skillLibrary.skillId")}</dt>
      <dd>${entry.skillId}</dd>
      <dt>${t("skillLibrary.revision")}</dt>
      <dd>${entry.revision}</dd>
      <dt>${t("skillLibrary.command")}</dt>
      <dd>${entry.name}</dd>
    </dl>
  </details>`;
}

/** Session access grants a read of one pin, never the library editor or revision history. */
export function renderLibraryPinRead(props: {
  read: SkillsLibraryReadResult;
  file: string;
  onFile: (file: string) => void;
  onClose: () => void;
}) {
  const { read } = props;
  const support = read.files.find((file) => file.path === props.file);
  const text = props.file === "SKILL.md" ? read.content : support ? libraryFileText(support) : null;
  return html`<openclaw-modal-dialog
    label=${read.entry.slug}
    style="--openclaw-modal-width: 960px;"
    @modal-cancel=${props.onClose}
  >
    <div class="md-preview-dialog__panel">
      <div class="md-preview-dialog__header">
        <strong>${read.entry.slug}</strong
        ><button type="button" class="btn btn--sm" @click=${props.onClose}>
          ${t("common.close")}
        </button>
      </div>
      <div
        class="md-preview-dialog__body"
        style="display: grid; gap: var(--space-4); min-width: 0;"
      >
        <p>
          ${t("skillLibrary.ownerRevision", {
            owner: read.entry.ownerLabel,
            revision: read.entry.revision.slice(0, 8),
          })}
        </p>
        <p class="muted">${t("skillLibrary.session.readOnly")}</p>
        <label class="field"
          ><span>${t("skillLibrary.file")}</span
          ><select
            class="settings-select"
            .value=${props.file}
            @change=${(event: Event) =>
              props.onFile(libraryEventControl(event, HTMLSelectElement).value)}
          >
            <option value="SKILL.md" ?selected=${props.file === "SKILL.md"}>SKILL.md</option>
            ${read.files.map(
              (file) =>
                html`<option value=${file.path} ?selected=${props.file === file.path}>
                  ${file.path}
                </option>`,
            )}
          </select></label
        >
        ${text === null
          ? html`<p class="muted">${t("skillLibrary.binaryRead")}</p>`
          : html`<label class="field"
              ><span>${props.file}</span
              ><textarea
                class="settings-input"
                readonly
                spellcheck="false"
                rows="16"
                style="font-family: var(--mono); min-width: 0; max-width: 100%; box-sizing: border-box; resize: vertical;"
                .value=${text}
              ></textarea>
            </label>`}
        ${renderLibraryIdentity(read.entry)}
      </div>
    </div>
  </openclaw-modal-dialog>`;
}
