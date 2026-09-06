import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import { syncDropdownItemRadio } from "../../components/web-awesome.ts";
import { t } from "../../i18n/index.ts";
import { renderProviderIcon } from "./model-setup-icon-loader.ts";

type ManualProvider = SystemAgentSetupDetectResult["manualProviders"][number];

type WebAwesomeSelectEvent = CustomEvent<{
  item: HTMLElement & { checked?: boolean; value?: string };
}>;

function focusSelectedManualProvider(event: Event): void {
  const dropdown = event.currentTarget as HTMLElement;
  const options = Array.from(
    dropdown.querySelectorAll<HTMLElement & { active: boolean }>(
      "wa-dropdown-item[data-manual-provider]:not([disabled])",
    ),
  );
  const selected = options.find((option) => option.hasAttribute("data-selected")) ?? options[0];
  if (!selected) {
    return;
  }
  for (const option of options) {
    option.active = option === selected;
  }
  selected.focus({ preventScroll: true });
  selected.scrollIntoView?.({ block: "nearest" });
}

function handleManualProviderKeydown(event: KeyboardEvent): void {
  const dropdown = event.currentTarget as HTMLElement & { open: boolean };
  if (!dropdown.open) {
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    event.stopPropagation();
    const focusTarget = event.shiftKey
      ? dropdown.querySelector<HTMLElement>('[slot="trigger"]')
      : dropdown
          .closest(".model-setup__manual")
          ?.querySelector<HTMLElement>('input[type="password"]');
    dropdown.addEventListener("wa-after-hide", () => focusTarget?.focus({ preventScroll: true }), {
      once: true,
    });
    dropdown.open = false;
    return;
  }
  if (event.key !== "Escape") {
    return;
  }
  // The settings-level Escape shortcut runs before Web Awesome's document
  // listener. Claim the event here and restore the durable trigger after hide.
  event.preventDefault();
  dropdown.addEventListener(
    "wa-after-hide",
    () => dropdown.querySelector<HTMLElement>('[slot="trigger"]')?.focus({ preventScroll: true }),
    { once: true },
  );
}

function handleManualProviderSelect(
  event: WebAwesomeSelectEvent,
  currentProviderId: string,
  onChange: (providerId: string) => void,
): void {
  const item = event.detail.item;
  const dropdown = event.currentTarget as HTMLElement & { open: boolean };
  const value = item.value ?? item.getAttribute("value");
  if (!value) {
    return;
  }
  if (value !== currentProviderId) {
    dropdown.addEventListener(
      "wa-after-hide",
      () => dropdown.querySelector<HTMLElement>('[slot="trigger"]')?.focus({ preventScroll: true }),
      { once: true },
    );
    onChange(value);
    return;
  }
  event.preventDefault();
  item.checked = true;
  dropdown.querySelector<HTMLElement>('[slot="trigger"]')?.focus({ preventScroll: true });
  dropdown.open = false;
}

export function manualProviderName(provider: ManualProvider): string {
  return provider.groupLabel?.trim() || provider.label;
}

function manualProviderMethod(provider: ManualProvider): string | undefined {
  const method = provider.label.trim();
  return method === manualProviderName(provider) ? undefined : method;
}

export function renderManualProviderPicker(
  props: {
    manualProviderId: string;
    actionsDisabled: boolean;
    iconUrls: Readonly<Record<string, string>>;
    onIconError: (url: string) => void;
    onManualProviderChange: (providerId: string) => void;
  },
  result: Pick<SystemAgentSetupDetectResult, "manualProviders">,
  provider: ManualProvider | undefined,
) {
  const providerMethod = provider ? manualProviderMethod(provider) : undefined;
  const triggerLabel = provider
    ? [manualProviderName(provider), providerMethod].filter(Boolean).join(", ")
    : t("modelSetup.manual.selectProvider");
  return html`
    <wa-dropdown
      class="model-setup-provider-select"
      placement="bottom-start"
      aria-label=${t("modelSetup.manual.provider")}
      @wa-select=${(event: WebAwesomeSelectEvent) =>
        handleManualProviderSelect(event, props.manualProviderId, props.onManualProviderChange)}
      @wa-after-show=${focusSelectedManualProvider}
      @keydown=${handleManualProviderKeydown}
    >
      <button
        slot="trigger"
        type="button"
        class="model-setup-provider-select__trigger"
        aria-label=${`${t("modelSetup.manual.provider")}: ${triggerLabel}`}
        ?disabled=${props.actionsDisabled || result.manualProviders.length === 0}
      >
        ${
          provider
            ? renderProviderIcon(props, provider, "model-setup__icon--picker")
            : html`<span class="model-setup-provider-select__placeholder-icon" aria-hidden="true">
                ${icons.key}
              </span>`
        }
        <span class="model-setup-provider-select__copy">
          <strong>
            ${provider ? manualProviderName(provider) : t("modelSetup.manual.selectProvider")}
          </strong>
          ${
            provider
              ? providerMethod
                ? html`<span>${providerMethod}</span>`
                : nothing
              : html`<span>${t("modelSetup.manual.selectProviderHint")}</span>`
          }
        </span>
        <span class="model-setup-provider-select__chevron" aria-hidden="true">
          ${icons.chevronDown}
        </span>
      </button>
      ${result.manualProviders
        .toSorted((a, b) => manualProviderName(a).localeCompare(manualProviderName(b)))
        .map((entry) => {
          const selected = entry.id === props.manualProviderId;
          const entryMethod = manualProviderMethod(entry);
          const accessibleLabel = [manualProviderName(entry), entryMethod, entry.hint]
            .filter(Boolean)
            .join(", ");
          return html`
            <wa-dropdown-item
              class="model-setup-provider-select__option"
              data-manual-provider=${entry.id}
              ?data-selected=${selected}
              aria-label=${accessibleLabel}
              .value=${entry.id}
              type="checkbox"
              .checked=${selected}
              ?disabled=${props.actionsDisabled}
              ${ref((element) => syncDropdownItemRadio(element, selected))}
            >
              <span slot="icon">
                ${renderProviderIcon(props, entry, "model-setup__icon--picker")}
              </span>
              <span class="model-setup-provider-select__copy">
                <strong>${manualProviderName(entry)}</strong>
                ${entryMethod ? html`<span>${entryMethod}</span>` : nothing}
                ${entry.hint ? html`<small>${entry.hint}</small>` : nothing}
              </span>
            </wa-dropdown-item>
          `;
        })}
    </wa-dropdown>
  `;
}
