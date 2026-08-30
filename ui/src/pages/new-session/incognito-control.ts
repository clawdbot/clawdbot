import { html, nothing, svg } from "lit";
import { ref } from "lit/directives/ref.js";
import { strokeIcon } from "../../components/icons-tools.ts";
import { icons } from "../../components/icons.ts";
import { syncDropdownItemRadio } from "../../components/web-awesome.ts";
import { t } from "../../i18n/index.ts";
import type { NewSessionVisibility } from "./create-params.ts";

const shredderIcon = strokeIcon(svg` <path
    d="M4 13V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v5"
  />
  <path d="M14 2v5a1 1 0 0 0 1 1h5" />
  <path d="M10 22v-5" />
  <path d="M14 19v-2" />
  <path d="M18 20v-3" />
  <path d="M2 13h20" />
  <path d="M6 20v-3" />`);

type VisibilityOption = {
  value: NewSessionVisibility;
  label: string;
  description?: string;
  icon: ReturnType<typeof strokeIcon>;
  disabled?: boolean;
  disabledReason?: string;
};

/** One closed session-mode selector for the fixed new-session rail. */
export function renderNewSessionVisibilityControl(
  submission: {
    visibility: NewSessionVisibility;
    submitting: boolean;
    pendingPlacement: { sessionKey: string };
    incognitoDisabledReason: () => string | undefined;
    setVisibility: (visibility: NewSessionVisibility) => void;
  },
  draftAvailable: boolean,
) {
  const incognitoDisabledReason = submission.incognitoDisabledReason();
  const defaultOption: VisibilityOption = {
    value: "normal",
    label: t("common.default"),
    icon: icons.radio,
  };
  const options: VisibilityOption[] = [
    defaultOption,
    ...(draftAvailable
      ? [
          {
            value: "draft" as const,
            label: t("newSession.draft"),
            description: t("newSession.draftDescription"),
            icon: icons.pencil,
          },
        ]
      : []),
    {
      value: "incognito",
      label: t("newSession.incognito"),
      description: t("newSession.incognitoDescription"),
      icon: shredderIcon,
      disabled: Boolean(incognitoDisabledReason),
      disabledReason: incognitoDisabledReason,
    },
  ];
  const selected =
    options.find((option) => option.value === submission.visibility) ?? defaultOption;
  const disabled = submission.submitting || Boolean(submission.pendingPlacement.sessionKey);
  const modeLabel = t("common.mode");
  return html`
    <div class="new-session-page__visibility-rail">
      <wa-dropdown
        class="new-session-page__visibility-menu"
        placement="bottom-end"
        @wa-select=${(event: CustomEvent<{ item?: { value?: string } }>) => {
          const value = event.detail.item?.value;
          const option = options.find((entry) => entry.value === value);
          if (!disabled && option && !option.disabled) {
            submission.setVisibility(option.value);
          }
        }}
      >
        <button
          slot="trigger"
          type="button"
          class="shell-chrome-controls__button new-session-page__visibility-trigger ${submission.visibility !==
          "normal"
            ? "new-session-page__visibility-trigger--active"
            : ""}"
          aria-label=${`${modeLabel}: ${selected.label}`}
          aria-haspopup="menu"
          ?disabled=${disabled}
          title=${selected.description ?? modeLabel}
        >
          <span aria-hidden="true">${selected.icon}</span>
          <span>${selected.label}</span>
          <span class="new-session-page__visibility-chevron" aria-hidden="true"
            >${icons.chevronDown}</span
          >
        </button>
        ${options.map((option) => {
          const checked = option.value === submission.visibility;
          return html`
            <wa-dropdown-item
              class="new-session-page__visibility-option"
              value=${option.value}
              role="menuitemradio"
              aria-checked=${String(checked)}
              ${ref((element) => syncDropdownItemRadio(element, checked))}
              ?disabled=${option.disabled}
              title=${option.disabledReason ?? nothing}
            >
              <span slot="icon" aria-hidden="true">${option.icon}</span>
              <span class="new-session-page__visibility-option-copy">
                <span>${option.label}</span>
                ${option.description
                  ? html`<span class="new-session-page__visibility-option-description"
                      >${option.disabledReason ?? option.description}</span
                    >`
                  : nothing}
              </span>
              ${checked
                ? html`<span slot="details" aria-hidden="true">${icons.check}</span>`
                : nothing}
            </wa-dropdown-item>
          `;
        })}
      </wa-dropdown>
    </div>
  `;
}

/** Persistent context beside the draft while ephemeral session mode is active. */
export function renderNewSessionIncognitoNotice(active: boolean) {
  const description = t("newSession.incognitoDescription");
  return html`
    <div
      class="new-session-page__incognito-notice ${active
        ? "new-session-page__incognito-notice--visible"
        : ""}"
      role="status"
      aria-hidden=${String(!active)}
    >
      <span class="new-session-page__incognito-notice-icon" aria-hidden="true">
        ${shredderIcon}
      </span>
      <span>${description}</span>
    </div>
  `;
}
