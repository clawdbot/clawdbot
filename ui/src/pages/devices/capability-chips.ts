import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";

type CapabilityPresentation = {
  icon: TemplateResult;
  labelKey: string;
  descriptionKey: string;
};

const CAPABILITY_PRESENTATIONS = new Map<string, CapabilityPresentation>(
  Object.entries({
    browser: {
      icon: icons.globe,
      labelKey: "devices.capabilities.browser.label",
      descriptionKey: "devices.capabilities.browser.description",
    },
    canvas: {
      icon: icons.panelsTopLeft,
      labelKey: "devices.capabilities.canvas.label",
      descriptionKey: "devices.capabilities.canvas.description",
    },
    screen: {
      icon: icons.monitor,
      labelKey: "devices.capabilities.screen.label",
      descriptionKey: "devices.capabilities.screen.description",
    },
    computer: {
      icon: icons.monitorSmartphone,
      labelKey: "devices.capabilities.computer.label",
      descriptionKey: "devices.capabilities.computer.description",
    },
    file: {
      icon: icons.folder,
      labelKey: "devices.capabilities.file.label",
      descriptionKey: "devices.capabilities.file.description",
    },
    system: {
      icon: icons.terminal,
      labelKey: "devices.capabilities.system.label",
      descriptionKey: "devices.capabilities.system.description",
    },
    mcp: {
      icon: icons.plug,
      labelKey: "devices.capabilities.mcp.label",
      descriptionKey: "devices.capabilities.mcp.description",
    },
    "local-inference": {
      icon: icons.cpu,
      labelKey: "devices.capabilities.localInference.label",
      descriptionKey: "devices.capabilities.localInference.description",
    },
    camera: {
      icon: icons.camera,
      labelKey: "devices.capabilities.camera.label",
      descriptionKey: "devices.capabilities.camera.description",
    },
    talk: {
      icon: icons.mic,
      labelKey: "devices.capabilities.talk.label",
      descriptionKey: "devices.capabilities.talk.description",
    },
    location: {
      icon: icons.target,
      labelKey: "devices.capabilities.location.label",
      descriptionKey: "devices.capabilities.location.description",
    },
    notifications: {
      icon: icons.bell,
      labelKey: "devices.capabilities.notifications.label",
      descriptionKey: "devices.capabilities.notifications.description",
    },
    contacts: {
      icon: icons.users,
      labelKey: "devices.capabilities.contacts.label",
      descriptionKey: "devices.capabilities.contacts.description",
    },
    calendar: {
      icon: icons.calendarClock,
      labelKey: "devices.capabilities.calendar.label",
      descriptionKey: "devices.capabilities.calendar.description",
    },
    reminders: {
      icon: icons.listChecks,
      labelKey: "devices.capabilities.reminders.label",
      descriptionKey: "devices.capabilities.reminders.description",
    },
    device: {
      icon: icons.smartphone,
      labelKey: "devices.capabilities.device.label",
      descriptionKey: "devices.capabilities.device.description",
    },
    photos: {
      icon: icons.image,
      labelKey: "devices.capabilities.photos.label",
      descriptionKey: "devices.capabilities.photos.description",
    },
    sms: {
      icon: icons.messageSquare,
      labelKey: "devices.capabilities.sms.label",
      descriptionKey: "devices.capabilities.sms.description",
    },
    health: {
      icon: icons.activity,
      labelKey: "devices.capabilities.health.label",
      descriptionKey: "devices.capabilities.health.description",
    },
    motion: {
      icon: icons.radio,
      labelKey: "devices.capabilities.motion.label",
      descriptionKey: "devices.capabilities.motion.description",
    },
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
      ${runtimes.length > 0
        ? renderCapabilityChip(icons.squareTerminal, runtimeLabel, runtimeTitle)
        : nothing}
      ${visible.map((cap) => {
        const presentation = CAPABILITY_PRESENTATIONS.get(cap);
        const icon = presentation?.icon ?? icons.puzzle;
        const label = presentation ? t(presentation.labelKey) : cap;
        const title = presentation ? t(presentation.descriptionKey) : cap;
        return renderCapabilityChip(icon, label, title);
      })}
      ${overflow > 0
        ? html`<span
            class="device-capability device-capability--overflow"
            role="listitem"
            title=${t("devices.capabilities.overflow", { count: String(overflow) })}
            >+${overflow}</span
          >`
        : nothing}
    </div>
  `;
}
