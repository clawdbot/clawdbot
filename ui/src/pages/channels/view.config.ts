// Control UI view renders channels screen content.
import { html } from "lit";
import type { ConfigUiHints } from "../../api/types.ts";
import {
  analyzeConfigSchema,
  renderNode,
  schemaType,
  type JsonSchema,
} from "../../components/config-form.ts";
import { t } from "../../i18n/index.ts";
import { formatChannelExtraValue, resolveChannelConfigValue } from "../../lib/channels/index.ts";
import type { ChannelsProps } from "./view.types.ts";

type ChannelConfigFormProps = {
  channelId: string;
  configValue: Record<string, unknown> | null;
  schema: unknown;
  uiHints: ConfigUiHints;
  disabled: boolean;
  onPatch: (path: Array<string | number>, value: unknown) => void;
};

function resolveSchemaNode(
  schema: JsonSchema | null,
  path: Array<string | number>,
): JsonSchema | null {
  let current = schema;
  for (const key of path) {
    if (!current) {
      return null;
    }
    const type = schemaType(current);
    if (type === "object") {
      const properties = current.properties ?? {};
      if (typeof key === "string" && properties[key]) {
        current = properties[key];
        continue;
      }
      const additional = current.additionalProperties;
      if (typeof key === "string" && additional && typeof additional === "object") {
        current = additional;
        continue;
      }
      return null;
    }
    if (type === "array") {
      if (typeof key !== "number") {
        return null;
      }
      const items = Array.isArray(current.items) ? current.items[0] : current.items;
      current = items ?? null;
      continue;
    }
    return null;
  }
  return current;
}

function resolveChannelValue(
  config: Record<string, unknown>,
  channelId: string,
): Record<string, unknown> {
  return resolveChannelConfigValue(config, channelId) ?? {};
}

const EXTRA_CHANNEL_FIELDS = ["groupPolicy", "streamMode", "dmPolicy"] as const;

function renderExtraChannelFields(value: Record<string, unknown>) {
  const entries = EXTRA_CHANNEL_FIELDS.flatMap((field) => {
    if (!(field in value)) {
      return [];
    }
    return [[field, value[field]]] as Array<[string, unknown]>;
  });
  if (entries.length === 0) {
    return null;
  }
  return html`
    <div>
      ${entries.map(
        ([field, raw]) => html`
          <div class="settings-row__desc">${field}: ${formatChannelExtraValue(raw)}</div>
        `,
      )}
    </div>
  `;
}

function renderChannelConfigForm(props: ChannelConfigFormProps) {
  const analysis = analyzeConfigSchema(props.schema);
  const normalized = analysis.schema;
  if (!normalized) {
    return html`<div class="settings-row__desc">${t("channels.config.schemaUnavailable")}</div>`;
  }
  const node = resolveSchemaNode(normalized, ["channels", props.channelId]);
  if (!node) {
    return html`
      <div class="settings-row__desc">${t("channels.config.channelSchemaUnavailable")}</div>
    `;
  }
  const configValue = props.configValue ?? {};
  const value = resolveChannelValue(configValue, props.channelId);
  return html`
    <div class="config-form">
      ${renderNode({
        schema: node,
        value,
        path: ["channels", props.channelId],
        hints: props.uiHints,
        unsupported: new Set(analysis.unsupportedPaths),
        disabled: props.disabled,
        showLabel: false,
        onPatch: props.onPatch,
      })}
    </div>
    ${renderExtraChannelFields(value)}
  `;
}

export function renderChannelConfigSection(params: { channelId: string; props: ChannelsProps }) {
  const { channelId, props } = params;
  const disabled = props.configSaving || props.configSchemaLoading;
  return html`
    <div class="settings-row settings-row--stacked">
      ${props.configSchemaLoading
        ? html`<div class="settings-row__desc">${t("channels.config.loadingSchema")}</div>`
        : renderChannelConfigForm({
            channelId,
            configValue: props.configForm,
            schema: props.configSchema,
            uiHints: props.configUiHints,
            disabled,
            onPatch: props.onConfigPatch,
          })}
      <div class="settings-row__control">
        <button
          class="btn primary"
          ?disabled=${disabled || !props.configFormDirty}
          @click=${() => props.onConfigSave()}
        >
          ${props.configSaving ? t("common.saving") : t("common.save")}
        </button>
        <button class="btn" ?disabled=${disabled} @click=${() => props.onConfigReload()}>
          ${t("common.reload")}
        </button>
      </div>
    </div>
  `;
}
