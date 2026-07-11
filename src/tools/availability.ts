// Evaluates tool descriptors against runtime availability constraints.
import type {
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ToolAvailabilityContext,
  ToolAvailabilityDiagnostic,
  ToolAvailabilityExpression,
  ToolAvailabilitySignal,
  ToolDescriptor,
} from "./types.js";

/**
 * Tool availability evaluator for descriptor-driven tool planning.
 *
 * Descriptors express why a tool can be shown as small signals; this module
 * turns those signals into diagnostics without knowing any concrete tool owner.
 */
function isRecord(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveConfigPath(
  config: JsonObject | undefined,
  path: readonly string[],
): JsonValue | undefined {
  let current: JsonValue | undefined = config;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function hasConfiguredValue(params: {
  value: JsonValue | undefined;
  signal: Extract<ToolAvailabilitySignal, { readonly kind: "config" }>;
  context: ToolAvailabilityContext;
}): boolean {
  const { value, signal } = params;
  if (value === undefined || value === null) {
    return false;
  }
  if ((signal.check ?? "exists") === "available") {
    // "available" delegates semantic checks, for example provider auth that is configured but stale.
    return (
      params.context.isConfigValueAvailable?.({
        value,
        path: signal.path,
        signal,
      }) === true
    );
  }
  if ((signal.check ?? "exists") === "exists") {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && Array.from(value).every((entry) => typeof entry === "string");
}

function isAvailabilitySignal(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ToolAvailabilitySignal {
  switch (value.kind) {
    case "always":
      return true;
    case "auth":
      return isNonEmptyString(value.providerId);
    case "config":
      return (
        isStringArray(value.path) &&
        (value.check === undefined ||
          value.check === "exists" ||
          value.check === "non-empty" ||
          value.check === "available")
      );
    case "env":
      return isNonEmptyString(value.name);
    case "plugin-enabled":
      return isNonEmptyString(value.pluginId);
    case "context":
      return isNonEmptyString(value.key) && (!("equals" in value) || isJsonPrimitive(value.equals));
    default:
      return false;
  }
}

function isAvailabilityExpression(
  value: unknown,
  active: WeakSet<object>,
): value is ToolAvailabilityExpression {
  if (!value || typeof value !== "object" || Array.isArray(value) || active.has(value)) {
    return false;
  }
  active.add(value);
  try {
    const expression = value as Record<string, unknown>;
    const shapeCount =
      Number("kind" in expression) + Number("allOf" in expression) + Number("anyOf" in expression);
    if (shapeCount !== 1) {
      return false;
    }
    if ("kind" in expression) {
      return isAvailabilitySignal(expression);
    }
    const entries = "allOf" in expression ? expression.allOf : expression.anyOf;
    return (
      Array.isArray(entries) &&
      Array.from(entries).every((entry) => isAvailabilityExpression(entry, active))
    );
  } finally {
    active.delete(value);
  }
}

function diagnostic(
  reason: ToolAvailabilityDiagnostic["reason"],
  signal: ToolAvailabilitySignal,
  message: string,
): ToolAvailabilityDiagnostic {
  return { reason, signal, message };
}

function evaluateSignal(
  signal: ToolAvailabilitySignal,
  context: ToolAvailabilityContext,
): ToolAvailabilityDiagnostic | null {
  switch (signal.kind) {
    case "always":
      return null;
    case "auth":
      return context.authProviderIds?.has(signal.providerId)
        ? null
        : diagnostic("auth-missing", signal, `Missing auth provider: ${signal.providerId}`);
    case "config": {
      const value = resolveConfigPath(context.config, signal.path);
      return hasConfiguredValue({ value, signal, context })
        ? null
        : diagnostic("config-missing", signal, `Missing config path: ${signal.path.join(".")}`);
    }
    case "env":
      return context.env?.[signal.name]?.trim()
        ? null
        : diagnostic("env-missing", signal, `Missing environment value: ${signal.name}`);
    case "plugin-enabled":
      return context.enabledPluginIds?.has(signal.pluginId)
        ? null
        : diagnostic("plugin-disabled", signal, `Plugin is not enabled: ${signal.pluginId}`);
    case "context": {
      const value: JsonPrimitive | undefined = context.values?.[signal.key];
      if (!("equals" in signal)) {
        return value === undefined
          ? diagnostic("context-mismatch", signal, `Missing context value: ${signal.key}`)
          : null;
      }
      return value === signal.equals
        ? null
        : diagnostic("context-mismatch", signal, `Context value did not match: ${signal.key}`);
    }
    default:
      return diagnostic("unsupported-signal", signal, "Unsupported availability signal");
  }
}

function evaluateExpression(
  expression: ToolAvailabilityExpression,
  context: ToolAvailabilityContext,
): readonly ToolAvailabilityDiagnostic[] {
  if ("kind" in expression) {
    const diagnosticLocal = evaluateSignal(expression, context);
    return diagnosticLocal ? [diagnosticLocal] : [];
  }
  if ("allOf" in expression) {
    if (expression.allOf.length === 0) {
      return [
        {
          reason: "unsupported-signal",
          message: "Empty availability allOf group",
        },
      ];
    }
    return expression.allOf.flatMap((entry) => evaluateExpression(entry, context));
  }
  if ("anyOf" in expression) {
    if (expression.anyOf.length === 0) {
      return [
        {
          reason: "unsupported-signal",
          message: "Empty availability anyOf group",
        },
      ];
    }
    const diagnostics = expression.anyOf.map((entry) => evaluateExpression(entry, context));
    // "unsupported-signal" marks a malformed descriptor, not a runtime condition, so it must surface
    // even when a sibling branch is available; otherwise an available branch masks an authoring error.
    const unsupported = diagnostics.flat().filter((entry) => entry.reason === "unsupported-signal");
    if (diagnostics.some((entries) => entries.length === 0)) {
      return unsupported;
    }
    return diagnostics.flat();
  }
  return [
    {
      reason: "unsupported-signal",
      message: "Unsupported availability expression",
    },
  ];
}

/** Evaluate one descriptor against runtime context and return hidden-tool diagnostics. */
export function evaluateToolAvailability(params: {
  descriptor: ToolDescriptor;
  context?: ToolAvailabilityContext;
}): readonly ToolAvailabilityDiagnostic[] {
  const context = params.context ?? {};
  const availability = params.descriptor.availability;
  if (availability === undefined) {
    return [];
  }
  if (!isAvailabilityExpression(availability, new WeakSet())) {
    return [
      {
        reason: "unsupported-signal",
        message: "Unsupported availability expression",
      },
    ];
  }
  return evaluateExpression(availability, context);
}
