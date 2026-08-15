/**
 * Public descriptor contracts for OpenClaw tool metadata.
 *
 * These types keep tool ownership, execution, and availability metadata in one
 * shared shape so descriptor producers and the descriptor cache agree.
 */
/** JSON primitive accepted in descriptor schemas and availability context values. */
type JsonPrimitive = string | number | boolean | null;

/** Readonly JSON value accepted by public descriptor metadata. */
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Readonly JSON object accepted by public descriptor metadata. */
export type JsonObject = { readonly [key: string]: JsonValue };

/** Owner family responsible for defining a tool descriptor. */
type ToolOwnerRef =
  | { readonly kind: "core" }
  | { readonly kind: "plugin"; readonly pluginId: string }
  | { readonly kind: "channel"; readonly channelId: string; readonly pluginId?: string }
  | { readonly kind: "mcp"; readonly serverId: string };

/** Runtime executor target used after a tool has passed availability planning. */
type ToolExecutorRef =
  | { readonly kind: "core"; readonly executorId: string }
  | { readonly kind: "plugin"; readonly pluginId: string; readonly toolName: string }
  | { readonly kind: "channel"; readonly channelId: string; readonly actionId: string }
  | { readonly kind: "mcp"; readonly serverId: string; readonly toolName: string };

/** Atomic condition used to decide whether a tool is visible. */
type ToolAvailabilitySignal =
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
type ToolAvailabilityExpression =
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
