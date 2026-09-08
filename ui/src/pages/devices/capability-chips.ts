import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";

registerDevicesEnglish();

type CapabilityPresentation = {
  icon: TemplateResult;
  /** i18n leaf under `devices.capabilities`. */
  key: string;
};

const CAPABILITY_PRESENTATIONS = new Map<string, CapabilityPresentation>(
  Object.entries({
    browser: { icon: icons.globe, key: "browser" },
    canvas: { icon: icons.panelsTopLeft, key: "canvas" },
    screen: { icon: icons.monitor, key: "screen" },
    computer: { icon: icons.monitorSmartphone, key: "computer" },
    file: { icon: icons.folder, key: "file" },
    system: { icon: icons.terminal, key: "system" },
    mcp: { icon: icons.plug, key: "mcp" },
    "local-inference": { icon: icons.cpu, key: "localInference" },
    camera: { icon: icons.camera, key: "camera" },
    talk: { icon: icons.mic, key: "talk" },
    location: { icon: icons.target, key: "location" },
    notifications: { icon: icons.bell, key: "notifications" },
    contacts: { icon: icons.users, key: "contacts" },
    calendar: { icon: icons.calendarClock, key: "calendar" },
    reminders: { icon: icons.listChecks, key: "reminders" },
    device: { icon: icons.smartphone, key: "device" },
    photos: { icon: icons.image, key: "photos" },
    sms: { icon: icons.messageSquare, key: "sms" },
    health: { icon: icons.activity, key: "health" },
    motion: { icon: icons.radio, key: "motion" },
  } satisfies Record<string, CapabilityPresentation>),
);

const SESSION_RUNTIME_CAPABILITIES: ReadonlySet<string> = new Set([
  "claude-sessions",
  "codex-cli-sessions",
  "codex-app-server-threads",
  "opencode-sessions",
  "pi-sessions",
]);

// Node-controlled lists are unbounded; grouping does not remove the inventory's render cap.
const CAPABILITY_CHIP_LIMIT = 16;

function renderCapabilityChip(icon: TemplateResult, label: string, title: string) {
  return html`
    <span class="device-capability" role="listitem" title=${title}>
      <span class="device-capability__icon" aria-hidden="true">${icon}</span>
      <span>${label}</span>
    </span>
  `;
}

export function renderCapabilityChips(caps: readonly string[]) {
  if (caps.length === 0) {
    return nothing;
  }
  const unique = [...new Set(caps)];
  const runtimes = unique.filter((cap) => SESSION_RUNTIME_CAPABILITIES.has(cap));
  const capabilities = unique.filter((cap) => !SESSION_RUNTIME_CAPABILITIES.has(cap));
  const visible = capabilities.slice(0, CAPABILITY_CHIP_LIMIT - (runtimes.length > 0 ? 1 : 0));
  const overflow = capabilities.length - visible.length;
  const runtimeLabel = t(
    runtimes.length === 1 ? "devices.capabilities.runtime" : "devices.capabilities.runtimes",
    { count: String(runtimes.length) },
  );
  const runtimeTitle = runtimes.join(", ");
  return html`
    <div class="device-capabilities" role="list" aria-label=${t("devices.inventory.capabilities")}>
      ${
        runtimes.length > 0
          ? renderCapabilityChip(icons.squareTerminal, runtimeLabel, runtimeTitle)
          : nothing
      }
      ${visible.map((cap) => {
        const presentation = CAPABILITY_PRESENTATIONS.get(cap);
        const icon = presentation?.icon ?? icons.puzzle;
        const label = presentation ? t(`devices.capabilities.${presentation.key}.label`) : cap;
        const title = presentation
          ? t(`devices.capabilities.${presentation.key}.description`)
          : cap;
        return renderCapabilityChip(icon, label, title);
      })}
      ${
        overflow > 0
          ? html`<span
              class="device-capability device-capability--overflow"
              role="listitem"
              title=${t("devices.capabilities.overflow", { count: String(overflow) })}
              >+${overflow}</span
            >`
          : nothing
      }
    </div>
  `;
}
