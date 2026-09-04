import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerSkillLibraryEnglish } from "../../../i18n/locales/en-skill-library.ts";
import type { ComposerLibraryProps } from "../composer-library-session.ts";
import { menuDivider, renderBackRow } from "./chat-composer-menu-rows.ts";

registerSkillLibraryEnglish();

function renderLibraryStatus(library: ComposerLibraryProps) {
  return html`
    ${
      library.loading || library.busy
        ? html`<div class="agent-chat__capability-menu-state" role="status">
            ${t("common.loading")}
          </div>`
        : nothing
    }
    ${
      library.error
        ? html`<div class="agent-chat__capability-menu-state" role="alert">${library.error}</div>
            <wa-dropdown-item value="library-reload">${t("common.retry")}</wa-dropdown-item>`
        : nothing
    }
    ${
      library.notice
        ? html`<div class="agent-chat__capability-menu-state" role="status">${library.notice}</div>`
        : nothing
    }
  `;
}

export function renderComposerLibraryMenu(library?: ComposerLibraryProps, skillId?: string) {
  if (!library) {
    return nothing;
  }
  const busy = library.busy || library.loading;
  const session = library.result?.session;
  if (skillId) {
    const pin = session?.selections.find((entry) => entry.skillId === skillId);
    return html`
      ${renderBackRow()} ${renderLibraryStatus(library)}
      ${
        pin
          ? html`
              <div class="agent-chat__capability-menu-state">
                <span class="agent-chat__capability-menu-label">
                  <strong>${pin.slug} · ${pin.ownerLabel}</strong>
                  <span class="agent-chat__capability-menu-note"
                    >${t("skillLibrary.session.pin", { revision: pin.revision.slice(0, 8) })}</span
                  >
                </span>
              </div>
              <wa-dropdown-item
                class="agent-chat__capability-menu-item"
                value=${`library-read:${pin.skillId}`}
                ?disabled=${busy}
                >${t("skillLibrary.session.read")}</wa-dropdown-item
              >
              ${
                library.canWrite
                  ? html`
                      <wa-dropdown-item
                        class="agent-chat__capability-menu-item"
                        value=${`library-refresh:${pin.skillId}`}
                        ?disabled=${busy}
                        >${t("skillLibrary.session.refresh")}</wa-dropdown-item
                      >
                      <wa-dropdown-item
                        class="agent-chat__capability-menu-item"
                        value=${`library-detach:${pin.skillId}`}
                        ?disabled=${busy}
                        >${t("skillLibrary.session.detach")}</wa-dropdown-item
                      >
                    `
                  : nothing
              }
            `
          : library.result && !busy
            ? html`<div class="agent-chat__capability-menu-state">${t("skillsPage.notFound")}</div>`
            : nothing
      }
    `;
  }
  if (
    library.result?.defaultTarget === "workspace" &&
    !session?.selections.length &&
    !session?.attachable.length
  ) {
    return nothing;
  }
  return html`
    <div class="agent-chat__capability-menu-state">${t("skillLibrary.session.selected")}</div>
    ${renderLibraryStatus(library)}
    ${session?.selections.map(
      (pin) => html`<wa-dropdown-item
        class="agent-chat__capability-menu-item"
        value=${`library-selected:${pin.skillId}`}
        ?disabled=${busy}
        title=${`${pin.slug} · ${pin.ownerLabel}`}
      >
        <span class="agent-chat__capability-menu-label"
          ><span>${pin.slug} · ${pin.ownerLabel}</span
          ><span class="agent-chat__capability-menu-note"
            >${t("skillLibrary.session.pin", { revision: pin.revision.slice(0, 8) })}</span
          ></span
        >
        <span slot="details" class="agent-chat__capability-menu-chevron" aria-hidden="true"
          >${icons.chevronRight}</span
        >
      </wa-dropdown-item>`,
    )}
    ${
      session && session.selections.length === 0
        ? html`<div class="agent-chat__capability-menu-state">
            ${t("skillLibrary.session.empty")}
          </div>`
        : nothing
    }
    ${
      session?.attachable.length
        ? html`${menuDivider()}
            <div class="agent-chat__capability-menu-state">
              ${t("skillLibrary.session.attachable")}
            </div>
            ${session.attachable.map(
              (entry) => html`<wa-dropdown-item
                class="agent-chat__capability-menu-item"
                value=${`library-attach:${entry.skillId}`}
                ?disabled=${busy || !library.canWrite}
              >
                <span class="agent-chat__capability-menu-label"
                  ><span title=${`${entry.slug} · ${entry.ownerLabel}`}
                    >${t("skillLibrary.session.attachNamed", {
                      name: entry.slug,
                      owner: entry.ownerLabel,
                    })}</span
                  ><span class="agent-chat__capability-menu-note" title=${entry.description}
                    >${entry.description}</span
                  ></span
                >
              </wa-dropdown-item>`,
            )}`
        : nothing
    }
    ${
      library.result
        ? html`<div class="agent-chat__capability-menu-state">
            ${t("skillLibrary.defaultLimit", { count: String(library.result.defaultSelectionLimit) })}
          </div>`
        : nothing
    }
    ${
      library.result?.defaultSelectionNotice
        ? html`<div class="agent-chat__capability-menu-state" role="status">
            ${library.result.defaultSelectionNotice}
          </div>`
        : nothing
    }
    ${menuDivider()}
    <div class="agent-chat__capability-menu-state">${t("skillLibrary.inventory")}</div>
  `;
}

export function handleComposerLibrarySelection(
  value: string,
  library: ComposerLibraryProps | undefined,
  changeView: (view: "skills" | `library:${string}`) => void,
): boolean {
  if (!value.startsWith("library-")) {
    return false;
  }
  if (value === "library-reload") {
    library?.onReload();
  } else if (library && !library.loading && !library.busy) {
    const skillId = value.slice(value.indexOf(":") + 1);
    const pin = library.result?.session?.selections.find((entry) => entry.skillId === skillId);
    if (value.startsWith("library-selected:") && pin) {
      changeView(`library:${pin.skillId}`);
    } else if (value.startsWith("library-read:") && pin) {
      library.onRead(pin.skillId, pin.revision);
    } else if (library.canWrite) {
      if (value.startsWith("library-attach:")) {
        const attachable = library.result?.session?.attachable.find(
          (entry) => entry.skillId === skillId,
        );
        if (attachable) {
          library.onActivate("attach", attachable.skillId, attachable.revision);
        }
      } else if (pin && value.startsWith("library-detach:")) {
        library.onActivate("detach", pin.skillId);
        changeView("skills");
      } else if (pin && value.startsWith("library-refresh:")) {
        library.onActivate("refresh", pin.skillId);
      }
    }
  }
  return true;
}
