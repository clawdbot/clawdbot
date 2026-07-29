// Control UI view dispatches config form schema node rendering.
import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { renderArray, renderJsonTextarea, renderObject } from "./config-form.node.collection.ts";
import { renderNumberInput, renderSelect, renderTextInput } from "./config-form.node.scalar.ts";
import {
  renderFieldRow,
  renderSegmentedControl,
  renderTags,
  type ConfigNodeRenderParams,
} from "./config-form.node.shared.ts";
import {
  hasConfigSearchCriteria as hasSearchCriteria,
  matchesNodeSearch,
  resolveConfigFieldMeta as resolveFieldMeta,
} from "./config-form.search.ts";
import { pathKey, schemaType } from "./config-form.shared.ts";
import { renderSettingsToggle, renderSettingsToggleRow } from "./settings-ui.ts";

export function renderNode(params: ConfigNodeRenderParams): TemplateResult | typeof nothing {
  const { schema, value, path, hints, unsupported, disabled, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const type = schemaType(schema);
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
  const key = pathKey(path);
  const criteria = params.searchCriteria;

  if (unsupported.has(key)) {
    return renderFieldRow({
      label,
      tags: [],
      showLabel: true,
      control: nothing,
      error: t("configForm.unsupportedNode"),
    });
  }
  if (
    criteria &&
    hasSearchCriteria(criteria) &&
    !matchesNodeSearch({ schema, value, path, hints, criteria })
  ) {
    return nothing;
  }

  // Handle anyOf/oneOf unions
  if (schema.anyOf || schema.oneOf) {
    const variants = schema.anyOf ?? schema.oneOf ?? [];
    const nonNull = variants.filter(
      (variant) =>
        !(
          variant.type === "null" ||
          (Array.isArray(variant.type) && variant.type.includes("null"))
        ),
    );

    if (nonNull.length === 1) {
      const selectedSchema = nonNull[0];
      return selectedSchema ? renderNode({ ...params, schema: selectedSchema }) : nothing;
    }

    // Check if it's a set of literal values (enum-like)
    const extractLiteral = (variant: (typeof nonNull)[number]): unknown => {
      if (variant.const !== undefined) {
        return variant.const;
      }
      if (variant.enum && variant.enum.length === 1) {
        return variant.enum[0];
      }
      return undefined;
    };
    const literals = nonNull.map(extractLiteral);
    const allLiterals = literals.every((literal) => literal !== undefined);

    if (allLiterals && literals.length > 0 && literals.length <= 5) {
      // Use segmented control for small sets
      const resolvedValue = value ?? schema.default;
      return renderFieldRow({
        label,
        help,
        tags,
        showLabel,
        control: renderSegmentedControl({
          options: literals,
          resolvedValue,
          disabled,
          ariaLabel: label,
          onSelect: (literal) => onPatch(path, literal),
        }),
      });
    }

    if (allLiterals && literals.length > 5) {
      // Use dropdown for larger sets
      return renderSelect({ ...params, options: literals, value: value ?? schema.default });
    }

    // Handle mixed primitive types
    const primitiveTypes = new Set(nonNull.map((variant) => schemaType(variant)).filter(Boolean));
    const normalizedTypes = new Set(
      [...primitiveTypes].map((variantType) =>
        variantType === "integer" ? "number" : variantType,
      ),
    );

    if (
      [...normalizedTypes].every((variantType) =>
        ["string", "number", "boolean"].includes(variantType as string),
      )
    ) {
      const hasString = normalizedTypes.has("string");
      const hasNumber = normalizedTypes.has("number");
      const hasBoolean = normalizedTypes.has("boolean");

      if (hasBoolean && normalizedTypes.size === 1) {
        return renderNode({
          ...params,
          schema: { ...schema, type: "boolean", anyOf: undefined, oneOf: undefined },
        });
      }

      if (hasString || hasNumber) {
        return renderTextInput({
          ...params,
          inputType: hasNumber && !hasString ? "number" : "text",
        });
      }
    }

    // Complex union (e.g. array | object) — render as JSON textarea
    return renderJsonTextarea(params);
  }

  // Enum - use segmented for small, dropdown for large
  if (schema.enum) {
    const options = schema.enum;
    if (options.length <= 5) {
      const resolvedValue = value ?? schema.default;
      return renderFieldRow({
        label,
        help,
        tags,
        showLabel,
        control: renderSegmentedControl({
          options,
          resolvedValue,
          disabled,
          ariaLabel: label,
          onSelect: (option) => onPatch(path, option),
        }),
      });
    }
    return renderSelect({ ...params, options, value: value ?? schema.default });
  }

  // Object type - collapsible section
  if (type === "object") {
    return renderObject(params, renderNode);
  }

  // Array type
  if (type === "array") {
    return renderArray(params, renderNode);
  }

  // Boolean - toggle row
  if (type === "boolean") {
    const displayValue =
      typeof value === "boolean"
        ? value
        : typeof schema.default === "boolean"
          ? schema.default
          : false;
    const onChange = (checked: boolean) => onPatch(path, checked);
    if (!showLabel) {
      // Control-only contexts (array items, map values) have no visible title,
      // so the switch keeps its accessible name from the field label.
      return renderFieldRow({
        label,
        help,
        tags,
        showLabel,
        control: renderSettingsToggle({
          checked: displayValue,
          disabled,
          ariaLabel: label,
          onChange,
        }),
      });
    }
    const description =
      help || tags.length > 0 ? html`${help ?? nothing}${renderTags(tags)}` : undefined;
    return renderSettingsToggleRow({
      title: label,
      description,
      checked: displayValue,
      disabled,
      onChange,
    });
  }

  // Number/Integer
  if (type === "number" || type === "integer") {
    return renderNumberInput(params);
  }

  // String
  if (type === "string") {
    return renderTextInput({ ...params, inputType: "text" });
  }

  // Fallback
  return renderFieldRow({
    label,
    tags: [],
    showLabel: true,
    control: nothing,
    error: t("configForm.unsupportedType", { type: String(type) }),
  });
}
