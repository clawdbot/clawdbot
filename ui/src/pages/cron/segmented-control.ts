import { html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import "../../components/web-awesome-tabs.ts";

export function renderSegmented<T extends string>(params: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string; testId?: string }>;
  ariaLabel?: string;
  onChange: (value: T) => void;
  /** Render as a tablist controlling `panelId`; option ids are `idPrefix` + value. */
  tabs?: { idPrefix: string; panelId: string };
}) {
  const tabs = params.tabs;
  if (tabs) {
    return html`
      <wa-tab-group
        class="settings-segmented cron-tabs"
        activation="manual"
        .active=${params.value}
        aria-label=${ifDefined(params.ariaLabel)}
        @wa-tab-show=${(event: CustomEvent<{ name: T }>) => params.onChange(event.detail.name)}
      >
        ${params.options.map(
          (option) => html`
            <wa-tab
              slot="nav"
              id=${`${tabs.idPrefix}${option.value}`}
              class="settings-segmented__btn cron-tab"
              panel=${option.value}
              .active=${option.value === params.value}
              aria-controls=${tabs.panelId}
              data-test-id=${ifDefined(option.testId)}
            >
              ${option.label}
            </wa-tab>
          `,
        )}
      </wa-tab-group>
    `;
  }
  return html`
    <wa-radio-group
      class="settings-segmented"
      size="s"
      orientation="horizontal"
      label=${ifDefined(params.ariaLabel)}
      .value=${params.value}
      @change=${(event: Event) => {
        const value = (event.currentTarget as HTMLElement & { value?: string }).value;
        if (value !== undefined) {
          params.onChange(value as T);
        }
      }}
    >
      ${params.options.map(
        (option) => html`
          <wa-radio
            class="settings-segmented__btn"
            appearance="button"
            value=${option.value}
            .checked=${option.value === params.value}
            data-test-id=${ifDefined(option.testId)}
          >
            ${option.label}
          </wa-radio>
        `,
      )}
    </wa-radio-group>
  `;
}
