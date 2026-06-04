/**
 * Public descriptor contracts for the generic OpenClaw tool planner.
 *
 * These types keep tool ownership, execution, availability, and protocol
 * metadata separate so core, plugins, channels, and MCP servers share one plan.
 */
/** JSON primitive accepted in descriptor schemas and availability context values. */
export type JsonPrimitive = string | number | boolean | null;

/** Readonly JSON value accepted by public descriptor metadata. */
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Readonly JSON object accepted by public descriptor metadata. */
export type JsonObject = { readonly [key: string]: JsonValue };

/** Owner family responsible for defining a tool descriptor. */
export type ToolOwnerRef =
  | { readonly kind: "core" }
  | { readonly kind: "plugin"; readonly pluginId: string }
  | { readonly kind: "channel"; readonly channelId: string; readonly pluginId?: string }
  | { readonly kind: "mcp"; readonly serverId: string };

/** Runtime executor target used after a tool has passed availability planning. */
export type ToolExecutorRef =
  | { readonly kind: "core"; readonly executorId: string }
  | { readonly kind: "plugin"; readonly pluginId: string; readonly toolName: string }
  | { readonly kind: "channel"; readonly channelId: string; readonly actionId: string }
  | { readonly kind: "mcp"; readonly serverId: string; readonly toolName: string };

/** Atomic condition used to decide whether a tool is visible. */
export type ToolAvailabilitySignal =
  | { readonly kind: "always" }
  | { readonly kind: "auth"; readonly providerId: string }
  | {
      readonly kind: "config";
      readonly path: readonly string[];
      readonly check?: "exists" | "non-empty" | "available";
    }
  | { readonly kind: "env"; readonly name: string }
  | { readonly kind: "plugin-enabled"; readonly pluginId: string }
  | { readonly kind: "context"; readonly key: string; readonly equals?: JsonPrimitive };

/** Boolean expression over tool availability signals. */
export type ToolAvailabilityExpression =
  | ToolAvailabilitySignal
  | { readonly allOf: readonly ToolAvailabilityExpression[] }
  | { readonly anyOf: readonly ToolAvailabilityExpression[] };

/** Public descriptor for a tool before runtime availability planning. */
export type ToolDescriptor = {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly owner: ToolOwnerRef;
  readonly executor?: ToolExecutorRef;
  readonly availability?: ToolAvailabilityExpression;
  readonly annotations?: JsonObject;
  readonly sortKey?: string;
};

/** Runtime facts used to evaluate descriptor availability expressions. */
export type ToolAvailabilityContext = {
  readonly authProviderIds?: ReadonlySet<string>;
  readonly config?: JsonObject;
  readonly isConfigValueAvailable?: (params: {
    readonly value: JsonValue;
    readonly path: readonly string[];
    readonly signal: Extract<ToolAvailabilitySignal, { readonly kind: "config" }>;
  }) => boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly enabledPluginIds?: ReadonlySet<string>;
  readonly values?: Readonly<Record<string, JsonPrimitive | undefined>>;
};

/** Stable reason code for an unavailable descriptor. */
export type ToolUnavailableReason =
  | "auth-missing"
  | "config-missing"
  | "context-mismatch"
  | "env-missing"
  | "plugin-disabled"
  | "unsupported-signal";

/** Diagnostic explaining why a descriptor is hidden from the visible plan. */
export type ToolAvailabilityDiagnostic = {
  readonly reason: ToolUnavailableReason;
  readonly signal?: ToolAvailabilitySignal;
  readonly message: string;
};

/** Visible, callable tool entry selected by the planner. */
export type ToolPlanEntry = {
  readonly descriptor: ToolDescriptor;
  readonly executor: ToolExecutorRef;
};

/** Hidden descriptor plus diagnostics explaining why it is unavailable. */
export type HiddenToolPlanEntry = {
  readonly descriptor: ToolDescriptor;
  readonly diagnostics: readonly ToolAvailabilityDiagnostic[];
};

/** Complete planner output split into visible and hidden descriptors. */
export type ToolPlan = {
  readonly visible: readonly ToolPlanEntry[];
  readonly hidden: readonly HiddenToolPlanEntry[];
};

/** Inputs required to build a tool plan. */
export type BuildToolPlanOptions = {
  readonly descriptors: readonly ToolDescriptor[];
  readonly availability?: ToolAvailabilityContext;
};
