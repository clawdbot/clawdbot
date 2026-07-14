// Settings design-language primitives. Every settings surface builds its
// layout through these helpers so pages cannot drift back into bespoke
// card/pill markup. Styles live in ui/src/styles/settings.css; rules in
// ui/docs/settings-design.md.
import "@awesome.me/webawesome/dist/components/radio/radio.js";
import "@awesome.me/webawesome/dist/components/radio-group/radio-group.js";
import "@awesome.me/webawesome/dist/components/switch/switch.js";
import { html, nothing, type TemplateResult } from "lit";
import { icons } from "./icons.ts";

type SettingsStatusKind = "ok" | "warn" | "danger" | "accent" | "muted";

type SettingsRowControl = TemplateResult | typeof nothing;

type SettingsRowProps = {
  title: unknown;
  description?: unknown;
  control?: SettingsRowControl;
  /** Full-width control below the text (textareas, segmented sets that wrap). */
  stacked?: boolean;
};

export type SettingsSectionProps = {
  title?: unknown;
  description?: unknown;
  /** Right-aligned inline actions next to the heading (e.g. an Add button). */
  actions?: TemplateResult;
  /** Extra count shown next to the heading. */
  count?: number;
  /** Marks the group surface as a danger zone. */
  danger?: boolean;
};

export function renderSettingsPage(
  children: unknown,
  options: { wide?: boolean; intro?: unknown } = {},
): TemplateResult {
  const className = options.wide ? "settings-page settings-page--wide" : "settings-page";
  return html`
    <div class=${className}>
      ${options.intro ? html`<p class="settings-page__intro">${options.intro}</p>` : nothing}
      ${children}
    </div>
  `;
}

/** Section = plain text heading + one group surface containing rows. */
export function renderSettingsSection(props: SettingsSectionProps, rows: unknown): TemplateResult {
  const heading =
    props.title || props.actions
      ? html`
          <div class="settings-section__header">
            ${props.title
              ? html`
                  <h2 class="settings-section__heading">
                    ${props.title}${props.count !== undefined
                      ? html` <span class="settings-count">${props.count}</span>`
                      : nothing}
                  </h2>
                `
              : nothing}
            ${props.actions
              ? html`<div class="settings-section__actions">${props.actions}</div>`
              : nothing}
          </div>
        `
      : nothing;
  const description = props.description
    ? html`<p class="settings-section__desc">${props.description}</p>`
    : nothing;
  const groupClass = props.danger ? "settings-group settings-group--danger" : "settings-group";
  return html`
    <section class="settings-section">
      ${heading}${description}
      <div class=${groupClass}>${rows}</div>
    </section>
  `;
}

/** A bare group surface without a section heading (rare; prefer sections). */
export function renderSettingsGroup(rows: unknown, options: { danger?: boolean } = {}) {
  const groupClass = options.danger ? "settings-group settings-group--danger" : "settings-group";
  return html`<div class=${groupClass}>${rows}</div>`;
}

export function renderSettingsRow(props: SettingsRowProps): TemplateResult {
  const className = props.stacked ? "settings-row settings-row--stacked" : "settings-row";
  return html`
    <div class=${className}>
      <div class="settings-row__text">
        <span class="settings-row__title">${props.title}</span>
        ${props.description
          ? html`<span class="settings-row__desc">${props.description}</span>`
          : nothing}
      </div>
      ${props.control !== undefined && props.control !== nothing
        ? html`<div class="settings-row__control">${props.control}</div>`
        : nothing}
    </div>
  `;
}

/** Clickable drill-in row with a trailing chevron. */
export function renderSettingsNavRow(
  props: Omit<SettingsRowProps, "stacked"> & { onClick: () => void },
): TemplateResult {
  return html`
    <button type="button" class="settings-row settings-row--nav" @click=${props.onClick}>
      <div class="settings-row__text">
        <span class="settings-row__title">${props.title}</span>
        ${props.description
          ? html`<span class="settings-row__desc">${props.description}</span>`
          : nothing}
      </div>
      <div class="settings-row__control">
        ${props.control ?? nothing}
        <span class="settings-row__chevron">${icons.chevronRight}</span>
      </div>
    </button>
  `;
}

/** Toggle for a custom control slot. ariaLabel is required because the row
 * title is not associated with the input; prefer renderSettingsToggleRow. */
export function renderSettingsToggle(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
}): TemplateResult {
  return html`
    <wa-switch
      class="settings-toggle"
      size="s"
      .checked=${props.checked}
      ?disabled=${props.disabled ?? false}
      @change=${(event: Event) => {
        props.onChange((event.currentTarget as HTMLElement & { checked: boolean }).checked);
      }}
    >
      <span class="settings-control__sr-label">${props.ariaLabel}</span>
    </wa-switch>
  `;
}

/** Toggle row: one <label> wraps title, description, and switch, so the whole
 * row is clickable and the checkbox gets its accessible name from the title. */
export function renderSettingsToggleRow(props: {
  title: unknown;
  description?: unknown;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}): TemplateResult {
  return html`
    <div
      class="settings-row settings-row--toggle"
      @click=${(event: MouseEvent) => {
        const target = event.target;
        if (props.disabled || (target instanceof Element && target.closest("wa-switch") !== null)) {
          return;
        }
        props.onChange(!props.checked);
      }}
    >
      <div class="settings-row__text">
        <span class="settings-row__title">${props.title}</span>
        ${props.description
          ? html`<span class="settings-row__desc">${props.description}</span>`
          : nothing}
      </div>
      <div class="settings-row__control">
        <wa-switch
          class="settings-toggle"
          size="s"
          .checked=${props.checked}
          ?disabled=${props.disabled ?? false}
          @change=${(event: Event) => {
            props.onChange((event.currentTarget as HTMLElement & { checked: boolean }).checked);
          }}
        >
          <span class="settings-control__sr-label">${props.title}</span>
        </wa-switch>
      </div>
    </div>
  `;
}

export function renderSettingsSegmented<T extends string>(props: {
  value: T;
  options: ReadonlyArray<{ value: T; label: unknown; title?: string }>;
  /** The selected radio is passed so callers can anchor visual transitions. */
  onChange: (value: T, element: HTMLElement) => void;
  disabled?: boolean;
  ariaLabel?: string;
}): TemplateResult {
  return html`
    <wa-radio-group
      class="settings-segmented"
      size="s"
      orientation="horizontal"
      .value=${props.value}
      ?disabled=${props.disabled ?? false}
      @change=${(event: Event) => {
        const value = (event.currentTarget as HTMLElement & { value?: string }).value;
        if (value !== undefined) {
          const group = event.currentTarget as HTMLElement;
          const selected = [...group.querySelectorAll<HTMLElement>("wa-radio")].find(
            (radio) => radio.getAttribute("value") === value,
          );
          props.onChange(value as T, selected ?? group);
        }
      }}
    >
      ${props.ariaLabel
        ? html`<span slot="label" class="settings-control__sr-label">${props.ariaLabel}</span>`
        : nothing}
      ${props.options.map(
        (option) => html`
          <wa-radio
            class="settings-segmented__btn ${option.value === props.value
              ? "settings-segmented__btn--active"
              : ""}"
            appearance="button"
            value=${option.value}
            .checked=${option.value === props.value}
            title=${option.title ?? nothing}
          >
            ${option.label}
          </wa-radio>
        `,
      )}
    </wa-radio-group>
  `;
}

/** Status = dot + plain text. Replaces status pills across settings. */
export function renderSettingsStatus(props: {
  kind: SettingsStatusKind;
  label: unknown;
}): TemplateResult {
  const modifier = props.kind === "muted" ? "" : ` settings-status--${props.kind}`;
  return html`
    <span class="settings-status${modifier}">
      <span class="settings-status__dot"></span>
      ${props.label}
    </span>
  `;
}

/** Right-aligned plain text value inside a row control. */
export function renderSettingsValue(value: unknown, options: { mono?: boolean } = {}) {
  const className = options.mono
    ? "settings-row__value settings-row__value--mono"
    : "settings-row__value";
  return html`<span class=${className}>${value}</span>`;
}

export function renderSettingsEmpty(message: unknown): TemplateResult {
  return html`<div class="settings-empty">${message}</div>`;
}
