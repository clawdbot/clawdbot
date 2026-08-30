// Control UI renderer for JSON-backed config form nodes.
import { nothing, type TemplateResult } from "lit";
import {
  getSensitiveRenderState,
  jsonValue,
  renderFieldRow,
  renderJsonTextareaControl,
  renderSchemaDefaultDescription,
  type ConfigNodeRenderParams,
} from "./config-form.node.shared.ts";
import { resolveConfigFieldMeta as resolveFieldMeta } from "./config-form.search.ts";
import { configFieldId } from "./config-form.shared.ts";

export function renderJsonTextarea(params: ConfigNodeRenderParams): TemplateResult {
  const { schema, value, path, hints, disabled, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
  const helpId = showLabel && help ? configFieldId(path, "description") : undefined;
  const fallback = jsonValue(value !== undefined ? value : schema.default);
  const sensitiveState = getSensitiveRenderState({
    path,
    value,
    hints,
    revealSensitive: params.revealSensitive ?? false,
    isSensitivePathRevealed: params.isSensitivePathRevealed,
  });
  const control = renderJsonTextareaControl({
    schema,
    path,
    ariaLabel: label,
    descriptionId: helpId,
    sourceValue: params.sourceIdentity ?? value,
    rowIdentity: params.rowIdentity,
    fallback,
    rows: 3,
    sensitiveState,
    disabled,
    isRequired: params.isRequired,
    onToggleSensitivePath: params.onToggleSensitivePath,
    onPatch,
  });

  return renderFieldRow({
    label,
    help,
    helpId,
    defaultDescription: sensitiveState.isRedacted
      ? nothing
      : renderSchemaDefaultDescription(schema, value),
    tags,
    showLabel,
    stacked: true,
    control,
  });
}
