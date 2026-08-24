import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import type {
  PluginSessionToolMode,
  SessionToolModeSelection,
} from "../../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../../components/icons.ts";
import { syncDropdownItemRadio } from "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";

export type ChatComposerToolModeMenuProps = {
  modes: readonly PluginSessionToolMode[];
  selected: SessionToolModeSelection | null;
  active: SessionToolModeSelection | null;
  runtimeId: string;
  disabled: boolean;
  disabledReason?: string | null;
  onSelect: (selection: SessionToolModeSelection) => void;
};

function sameSelection(
  left: SessionToolModeSelection | null,
  pluginId: string,
  modeId: string,
): boolean {
  return left?.pluginId === pluginId && left.modeId === modeId;
}

function renderModeOption(
  mode: PluginSessionToolMode,
  props: ChatComposerToolModeMenuProps,
  compatible: boolean,
  compatibilityTitle: string,
) {
  const checked = props.selected
    ? sameSelection(props.selected, mode.pluginId, mode.id)
    : mode.default === true;
  const active = sameSelection(props.active, mode.pluginId, mode.id);
  const pending = checked && props.active !== null && !active;
  return html`<wa-dropdown-item
    slot="submenu"
    class="agent-chat__capability-menu-item"
    value=${`tool-mode:${encodeURIComponent(mode.pluginId)}:${encodeURIComponent(mode.id)}`}
    role="menuitemradio"
    aria-checked=${String(checked)}
    ${ref((element) => syncDropdownItemRadio(element, checked))}
    ?disabled=${!compatible || props.disabled || checked}
    title=${compatible ? (props.disabledReason ?? "") : compatibilityTitle}
  >
    <span>${mode.label}</span>
    ${pending
      ? html`<span slot="details" class="agent-chat__capability-menu-note"
          >${t("chat.composer.menu.toolMode.next")}</span
        >`
      : active
        ? html`<span slot="details" class="agent-chat__capability-menu-note"
            >${t("chat.composer.menu.toolMode.active")}</span
          >`
        : nothing}
  </wa-dropdown-item>`;
}

export function renderChatComposerToolModeMenu(props: ChatComposerToolModeMenuProps) {
  const groups = new Map<string, PluginSessionToolMode[]>();
  for (const mode of props.modes) {
    groups.set(mode.pluginId, [...(groups.get(mode.pluginId) ?? []), mode]);
  }
  const selectedAvailable = props.selected
    ? props.modes.some((mode) => sameSelection(props.selected, mode.pluginId, mode.id))
    : true;
  const unavailableSelection =
    props.selected && !selectedAvailable
      ? html`<wa-dropdown-item
          class="agent-chat__capability-menu-item"
          disabled
          title=${t("chat.composer.menu.toolMode.unavailableDetail")}
        >
          <span slot="icon" aria-hidden="true">${icons.settings}</span>
          <span>${t("chat.composer.menu.toolMode.unavailable")}</span>
          <span slot="details" class="agent-chat__capability-menu-note"
            >${t("chat.composer.menu.toolMode.usingDefaults")}</span
          >
        </wa-dropdown-item>`
      : nothing;
  if (groups.size === 0) {
    return unavailableSelection;
  }
  const runtimeId = props.runtimeId.trim().toLowerCase();
  return html`${unavailableSelection}${[...groups.values()].map((modes) => {
    const first = modes[0];
    if (!first) {
      return nothing;
    }
    const compatible = runtimeId === "openclaw";
    const compatibilityTitle = compatible ? "" : "Available for openclaw sessions";
    return html`<wa-dropdown-item
      class="agent-chat__capability-menu-item agent-chat__tool-mode-menu"
      ?disabled=${!compatible || props.disabled}
      title=${compatible ? (props.disabledReason ?? "") : compatibilityTitle}
    >
      <span slot="icon" aria-hidden="true">${icons.settings}</span>
      <span>${first.controlLabel}</span>
      ${modes.map((mode) => renderModeOption(mode, props, compatible, compatibilityTitle))}
    </wa-dropdown-item>`;
  })}`;
}

export function handleChatComposerToolModeSelection(
  value: string,
  props: ChatComposerToolModeMenuProps | undefined,
): boolean {
  if (!props || !value.startsWith("tool-mode:")) {
    return false;
  }
  const [, pluginId, modeId] = value.split(":").map((part) => decodeURIComponent(part));
  if (pluginId && modeId && !props.disabled) {
    props.onSelect({ pluginId, modeId });
  }
  return true;
}
