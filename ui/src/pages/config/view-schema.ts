import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { schemaType, type JsonSchema } from "../../components/config-form.shared.ts";
import { analyzeConfigSchema, type ConfigSchemaAnalysis } from "../../components/config-form.ts";
import { t } from "../../i18n/index.ts";
import type { ConfigViewState } from "./view-types.ts";

function scopeSchemaSections(
  schema: JsonSchema | null,
  params: { include?: ReadonlySet<string> | null; exclude?: ReadonlySet<string> | null },
): JsonSchema | null {
  if (!schema || schemaType(schema) !== "object" || !schema.properties) {
    return schema;
  }
  const include = params.include;
  const exclude = params.exclude;
  const nextProps: Record<string, JsonSchema> = {};
  for (const key of Object.keys(schema.properties)) {
    if (include && include.size > 0 && !include.has(key)) {
      continue;
    }
    if (exclude && exclude.size > 0 && exclude.has(key)) {
      continue;
    }
    const property = schema.properties[key];
    if (property) {
      nextProps[key] = property;
    }
  }
  return { ...schema, properties: nextProps };
}

export function asConfigSchema(value: unknown): JsonSchema | null {
  if (!isRecord(value)) {
    return null;
  }
  return value as JsonSchema;
}

function configSectionKey(sections?: readonly string[]): string {
  return sections?.length ? sections.join("\u001f") : "";
}

export function getConfigSchemaAnalysis(
  viewState: ConfigViewState,
  schema: JsonSchema | null,
  includeSections?: readonly string[],
  excludeSections?: readonly string[],
  include?: ReadonlySet<string> | null,
  exclude?: ReadonlySet<string> | null,
): ConfigSchemaAnalysis {
  const includeKey = configSectionKey(includeSections);
  const excludeKey = configSectionKey(excludeSections);
  const cached = viewState.schemaAnalysisCache;
  if (
    cached &&
    cached.schema === schema &&
    cached.includeKey === includeKey &&
    cached.excludeKey === excludeKey
  ) {
    return cached.analysis;
  }
  const scopedSchema = scopeSchemaSections(schema, { include, exclude });
  const analysis = analyzeConfigSchema(scopedSchema);
  viewState.schemaAnalysisCache = { schema, includeKey, excludeKey, analysis };
  return analysis;
}

export function configValueExistsAtPath(
  value: Record<string, unknown> | null,
  pathString: string,
): boolean {
  if (!value || pathString === "<root>") {
    return false;
  }
  const segments = pathString.split(".");
  const visit = (current: unknown, index: number): boolean => {
    if (index === segments.length) {
      return current !== undefined;
    }
    if (current === null || typeof current !== "object") {
      return false;
    }
    const segment = segments[index];
    if (segment === "*") {
      return Object.values(current).some((entry) => visit(entry, index + 1));
    }
    if (!segment || !Object.hasOwn(current, segment)) {
      return false;
    }
    return visit((current as Record<string, unknown>)[segment], index + 1);
  };
  return visit(value, 0);
}

export function renderUnsupportedPathSummary(paths: string[]) {
  const marker = "__OPENCLAW_CONFIG_PATHS__";
  const key =
    paths.length === 1 ? "configView.formUnsafeCount" : "configView.formUnsafeCountPlural";
  const [prefix, suffix = ""] = t(key, {
    count: String(paths.length),
    paths: marker,
  }).split(marker);
  return html`
    <span class="config-content-callout__text">
      ${prefix}${paths
        .slice(0, 3)
        .map(
          (path, index) => html`${index > 0 ? ", " : ""}<code>${path}</code>`,
        )}${suffix}${paths.length > 3
        ? html` ${t("configView.formUnsafeMore", { count: String(paths.length - 3) })}`
        : nothing}
    </span>
  `;
}
