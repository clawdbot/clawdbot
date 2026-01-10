import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  codingTools,
  createEditTool,
  createReadTool,
  createWriteTool,
  readTool,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ClawdbotConfig } from "../config/config.js";
import { detectMime } from "../media/mime.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { resolveGatewayMessageProvider } from "../utils/message-provider.js";
import { startWebLoginWithQr, waitForWebLogin } from "../web/login-qr.js";
import {
  resolveAgentConfig,
  resolveAgentIdFromSessionKey,
} from "./agent-scope.js";
import {
  type BashToolDefaults,
  createBashTool,
  createProcessTool,
  type ProcessToolDefaults,
} from "./bash-tools.js";
import { createClawdbotTools } from "./clawdbot-tools.js";
import type { ModelAuthMode } from "./model-auth.js";
import type { SandboxContext, SandboxToolPolicy } from "./sandbox.js";
import { assertSandboxPath } from "./sandbox-paths.js";
import { cleanSchemaForGemini } from "./schema/clean-for-gemini.js";
import { sanitizeToolResultImages } from "./tool-images.js";

// NOTE(steipete): Upstream read now does file-magic MIME detection; we keep the wrapper
// to normalize payloads and sanitize oversized images before they hit providers.
type ToolContentBlock = AgentToolResult<unknown>["content"][number];
type ImageContentBlock = Extract<ToolContentBlock, { type: "image" }>;
type TextContentBlock = Extract<ToolContentBlock, { type: "text" }>;

async function sniffMimeFromBase64(
  base64: string,
): Promise<string | undefined> {
  const trimmed = base64.trim();
  if (!trimmed) return undefined;

  const take = Math.min(256, trimmed.length);
  const sliceLen = take - (take % 4);
  if (sliceLen < 8) return undefined;

  try {
    const head = Buffer.from(trimmed.slice(0, sliceLen), "base64");
    return await detectMime({ buffer: head });
  } catch {
    return undefined;
  }
}

function rewriteReadImageHeader(text: string, mimeType: string): string {
  // pi-coding-agent uses: "Read image file [image/png]"
  if (text.startsWith("Read image file [") && text.endsWith("]")) {
    return `Read image file [${mimeType}]`;
  }
  return text;
}

async function normalizeReadImageResult(
  result: AgentToolResult<unknown>,
  filePath: string,
): Promise<AgentToolResult<unknown>> {
  const content = Array.isArray(result.content) ? result.content : [];

  const image = content.find(
    (b): b is ImageContentBlock =>
      !!b &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "image" &&
      typeof (b as { data?: unknown }).data === "string" &&
      typeof (b as { mimeType?: unknown }).mimeType === "string",
  );
  if (!image) return result;

  if (!image.data.trim()) {
    throw new Error(`read: image payload is empty (${filePath})`);
  }

  const sniffed = await sniffMimeFromBase64(image.data);
  if (!sniffed) return result;

  if (!sniffed.startsWith("image/")) {
    throw new Error(
      `read: file looks like ${sniffed} but was treated as ${image.mimeType} (${filePath})`,
    );
  }

  if (sniffed === image.mimeType) return result;

  const nextContent = content.map((block) => {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "image"
    ) {
      const b = block as ImageContentBlock & { mimeType: string };
      return { ...b, mimeType: sniffed } satisfies ImageContentBlock;
    }
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      const b = block as TextContentBlock & { text: string };
      return {
        ...b,
        text: rewriteReadImageHeader(b.text, sniffed),
      } satisfies TextContentBlock;
    }
    return block;
  });

  return { ...result, content: nextContent };
}

// biome-ignore lint/suspicious/noExplicitAny: TypeBox schema type from pi-agent-core uses a different module instance.
type AnyAgentTool = AgentTool<any, unknown>;

function extractEnumValues(schema: unknown): unknown[] | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const record = schema as Record<string, unknown>;
  if (Array.isArray(record.enum)) return record.enum;
  if ("const" in record) return [record.const];
  return undefined;
}

function mergePropertySchemas(existing: unknown, incoming: unknown): unknown {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const existingEnum = extractEnumValues(existing);
  const incomingEnum = extractEnumValues(incoming);
  if (existingEnum || incomingEnum) {
    const values = Array.from(
      new Set([...(existingEnum ?? []), ...(incomingEnum ?? [])]),
    );
    const merged: Record<string, unknown> = {};
    for (const source of [existing, incoming]) {
      if (!source || typeof source !== "object") continue;
      const record = source as Record<string, unknown>;
      for (const key of ["title", "description", "default"]) {
        if (!(key in merged) && key in record) merged[key] = record[key];
      }
    }
    const types = new Set(values.map((value) => typeof value));
    if (types.size === 1) merged.type = Array.from(types)[0];
    merged.enum = values;
    return merged;
  }

  return existing;
}

function normalizeToolParameters(tool: AnyAgentTool): AnyAgentTool {
  const schema =
    tool.parameters && typeof tool.parameters === "object"
      ? (tool.parameters as Record<string, unknown>)
      : undefined;
  if (!schema) return tool;

  // Provider quirks:
  // - Gemini rejects several JSON Schema keywords, so we scrub those.
  // - OpenAI rejects function tool schemas unless the *top-level* is `type: "object"`.
  //   (TypeBox root unions compile to `{ anyOf: [...] }` without `type`).
  //
  // Normalize once here so callers can always pass `tools` through unchanged.

  // If schema already has type + properties (no top-level anyOf to merge),
  // still clean it for Gemini compatibility
  if (
    "type" in schema &&
    "properties" in schema &&
    !Array.isArray(schema.anyOf)
  ) {
    return {
      ...tool,
      parameters: cleanSchemaForGemini(schema),
    };
  }

  // Some tool schemas (esp. unions) may omit `type` at the top-level. If we see
  // object-ish fields, force `type: "object"` so OpenAI accepts the schema.
  if (
    !("type" in schema) &&
    (typeof schema.properties === "object" || Array.isArray(schema.required)) &&
    !Array.isArray(schema.anyOf) &&
    !Array.isArray(schema.oneOf)
  ) {
    return {
      ...tool,
      parameters: cleanSchemaForGemini({ ...schema, type: "object" }),
    };
  }

  const variantKey = Array.isArray(schema.anyOf)
    ? "anyOf"
    : Array.isArray(schema.oneOf)
      ? "oneOf"
      : null;
  if (!variantKey) return tool;
  const variants = schema[variantKey] as unknown[];
  const mergedProperties: Record<string, unknown> = {};
  const requiredCounts = new Map<string, number>();
  let objectVariants = 0;

  for (const entry of variants) {
    if (!entry || typeof entry !== "object") continue;
    const props = (entry as { properties?: unknown }).properties;
    if (!props || typeof props !== "object") continue;
    objectVariants += 1;
    for (const [key, value] of Object.entries(
      props as Record<string, unknown>,
    )) {
      if (!(key in mergedProperties)) {
        mergedProperties[key] = value;
        continue;
      }
      mergedProperties[key] = mergePropertySchemas(
        mergedProperties[key],
        value,
      );
    }
    const required = Array.isArray((entry as { required?: unknown }).required)
      ? (entry as { required: unknown[] }).required
      : [];
    for (const key of required) {
      if (typeof key !== "string") continue;
      requiredCounts.set(key, (requiredCounts.get(key) ?? 0) + 1);
    }
  }

  const baseRequired = Array.isArray(schema.required)
    ? schema.required.filter((key) => typeof key === "string")
    : undefined;
  const mergedRequired =
    baseRequired && baseRequired.length > 0
      ? baseRequired
      : objectVariants > 0
        ? Array.from(requiredCounts.entries())
            .filter(([, count]) => count === objectVariants)
            .map(([key]) => key)
        : undefined;

  const nextSchema: Record<string, unknown> = { ...schema };
  return {
    ...tool,
    // Flatten union schemas into a single object schema:
    // - Gemini doesn't allow top-level `type` together with `anyOf`.
    // - OpenAI rejects schemas without top-level `type: "object"`.
    // Merging properties preserves useful enums like `action` while keeping schemas portable.
    parameters: cleanSchemaForGemini({
      type: "object",
      ...(typeof nextSchema.title === "string"
        ? { title: nextSchema.title }
        : {}),
      ...(typeof nextSchema.description === "string"
        ? { description: nextSchema.description }
        : {}),
      properties:
        Object.keys(mergedProperties).length > 0
          ? mergedProperties
          : (schema.properties ?? {}),
      ...(mergedRequired && mergedRequired.length > 0
        ? { required: mergedRequired }
        : {}),
      additionalProperties:
        "additionalProperties" in schema ? schema.additionalProperties : true,
    }),
  };
}

function cleanToolSchemaForGemini(schema: Record<string, unknown>): unknown {
  return cleanSchemaForGemini(schema);
}

function normalizeToolNames(list?: string[]) {
  if (!list) return [];
  return list.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

const DEFAULT_SUBAGENT_TOOL_DENY = [
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
];

function resolveSubagentToolPolicy(cfg?: ClawdbotConfig): SandboxToolPolicy {
  const configured = cfg?.tools?.subagents?.tools;
  const deny = [
    ...DEFAULT_SUBAGENT_TOOL_DENY,
    ...(Array.isArray(configured?.deny) ? configured.deny : []),
  ];
  const allow = Array.isArray(configured?.allow) ? configured.allow : undefined;
  return { allow, deny };
}

function filterToolsByPolicy(
  tools: AnyAgentTool[],
  policy?: SandboxToolPolicy,
) {
  if (!policy) return tools;
  const deny = new Set(normalizeToolNames(policy.deny));
  const allowRaw = normalizeToolNames(policy.allow);
  const allow = allowRaw.length > 0 ? new Set(allowRaw) : null;
  return tools.filter((tool) => {
    const name = tool.name.toLowerCase();
    if (deny.has(name)) return false;
    if (allow) return allow.has(name);
    return true;
  });
}

function resolveEffectiveToolPolicy(params: {
  config?: ClawdbotConfig;
  sessionKey?: string;
}) {
  const agentId = params.sessionKey
    ? resolveAgentIdFromSessionKey(params.sessionKey)
    : undefined;
  const agentConfig =
    params.config && agentId
      ? resolveAgentConfig(params.config, agentId)
      : undefined;
  const agentTools = agentConfig?.tools;
  const hasAgentToolPolicy =
    Array.isArray(agentTools?.allow) || Array.isArray(agentTools?.deny);
  const globalTools = params.config?.tools;
  return {
    agentId,
    policy: hasAgentToolPolicy ? agentTools : globalTools,
  };
}

function isToolAllowedByPolicy(name: string, policy?: SandboxToolPolicy) {
  if (!policy) return true;
  const deny = new Set(normalizeToolNames(policy.deny));
  const allowRaw = normalizeToolNames(policy.allow);
  const allow = allowRaw.length > 0 ? new Set(allowRaw) : null;
  const normalized = name.trim().toLowerCase();
  if (deny.has(normalized)) return false;
  if (allow) return allow.has(normalized);
  return true;
}

function isToolAllowedByPolicies(
  name: string,
  policies: Array<SandboxToolPolicy | undefined>,
) {
  return policies.every((policy) => isToolAllowedByPolicy(name, policy));
}

function wrapSandboxPathGuard(tool: AnyAgentTool, root: string): AnyAgentTool {
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const record =
        args && typeof args === "object"
          ? (args as Record<string, unknown>)
          : undefined;
      const filePath = record?.path;
      if (typeof filePath === "string" && filePath.trim()) {
        await assertSandboxPath({ filePath, cwd: root, root });
      }
      return tool.execute(toolCallId, args, signal, onUpdate);
    },
  };
}

function createSandboxedReadTool(root: string) {
  const base = createReadTool(root);
  return wrapSandboxPathGuard(createClawdbotReadTool(base), root);
}

function createSandboxedWriteTool(root: string) {
  const base = createWriteTool(root);
  return wrapSandboxPathGuard(base as unknown as AnyAgentTool, root);
}

function createSandboxedEditTool(root: string) {
  const base = createEditTool(root);
  return wrapSandboxPathGuard(base as unknown as AnyAgentTool, root);
}

function createWhatsAppLoginTool(): AnyAgentTool {
  return {
    label: "WhatsApp Login",
    name: "whatsapp_login",
    description:
      "Generate a WhatsApp QR code for linking, or wait for the scan to complete.",
    // NOTE: Using Type.Unsafe for action enum instead of Type.Union([Type.Literal(...)])
    // because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
    parameters: Type.Object({
      action: Type.Unsafe<"start" | "wait">({
        type: "string",
        enum: ["start", "wait"],
      }),
      timeoutMs: Type.Optional(Type.Number()),
      force: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, args) => {
      const action = (args as { action?: string })?.action ?? "start";
      if (action === "wait") {
        const result = await waitForWebLogin({
          timeoutMs:
            typeof (args as { timeoutMs?: unknown }).timeoutMs === "number"
              ? (args as { timeoutMs?: number }).timeoutMs
              : undefined,
        });
        return {
          content: [{ type: "text", text: result.message }],
          details: { connected: result.connected },
        };
      }

      const result = await startWebLoginWithQr({
        timeoutMs:
          typeof (args as { timeoutMs?: unknown }).timeoutMs === "number"
            ? (args as { timeoutMs?: number }).timeoutMs
            : undefined,
        force:
          typeof (args as { force?: unknown }).force === "boolean"
            ? (args as { force?: boolean }).force
            : false,
      });

      if (!result.qrDataUrl) {
        return {
          content: [
            {
              type: "text",
              text: result.message,
            },
          ],
          details: { qr: false },
        };
      }

      const text = [
        result.message,
        "",
        "Open WhatsApp → Linked Devices and scan:",
        "",
        `![whatsapp-qr](${result.qrDataUrl})`,
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: { qr: true },
      };
    },
  };
}

function createClawdbotReadTool(base: AnyAgentTool): AnyAgentTool {
  return {
    ...base,
    execute: async (toolCallId, params, signal) => {
      const result = (await base.execute(
        toolCallId,
        params,
        signal,
      )) as AgentToolResult<unknown>;
      const record =
        params && typeof params === "object"
          ? (params as Record<string, unknown>)
          : undefined;
      const filePath =
        typeof record?.path === "string" ? String(record.path) : "<unknown>";
      const normalized = await normalizeReadImageResult(result, filePath);
      return sanitizeToolResultImages(normalized, `read:${filePath}`);
    },
  };
}

export const __testing = {
  cleanToolSchemaForGemini,
} as const;

function throwAbortError(): never {
  const err = new Error("Aborted");
  err.name = "AbortError";
  throw err;
}

function combineAbortSignals(
  a?: AbortSignal,
  b?: AbortSignal,
): AbortSignal | undefined {
  if (!a && !b) return undefined;
  if (a && !b) return a;
  if (b && !a) return b;
  if (a?.aborted) return a;
  if (b?.aborted) return b;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([a as AbortSignal, b as AbortSignal]);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  a?.addEventListener("abort", onAbort, { once: true });
  b?.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

function wrapToolWithAbortSignal(
  tool: AnyAgentTool,
  abortSignal?: AbortSignal,
): AnyAgentTool {
  if (!abortSignal) return tool;
  const execute = tool.execute;
  if (!execute) return tool;
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const combined = combineAbortSignals(signal, abortSignal);
      if (combined?.aborted) throwAbortError();
      return await execute(toolCallId, params, combined, onUpdate);
    },
  };
}

export function createClawdbotCodingTools(options?: {
  bash?: BashToolDefaults & ProcessToolDefaults;
  messageProvider?: string;
  agentAccountId?: string;
  sandbox?: SandboxContext | null;
  sessionKey?: string;
  agentDir?: string;
  workspaceDir?: string;
  config?: ClawdbotConfig;
  abortSignal?: AbortSignal;
  /**
   * Provider of the currently selected model (used for provider-specific tool quirks).
   * Example: "anthropic", "openai", "google", "openai-codex".
   */
  modelProvider?: string;
  /**
   * Auth mode for the current provider. We only need this for Anthropic OAuth
   * tool-name blocking quirks.
   */
  modelAuthMode?: ModelAuthMode;
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
}): AnyAgentTool[] {
  const bashToolName = "bash";
  const sandbox = options?.sandbox?.enabled ? options.sandbox : undefined;
  const { agentId, policy: effectiveToolsPolicy } = resolveEffectiveToolPolicy({
    config: options?.config,
    sessionKey: options?.sessionKey,
  });
  const scopeKey =
    options?.bash?.scopeKey ?? (agentId ? `agent:${agentId}` : undefined);
  const subagentPolicy =
    isSubagentSessionKey(options?.sessionKey) && options?.sessionKey
      ? resolveSubagentToolPolicy(options.config)
      : undefined;
  const allowBackground = isToolAllowedByPolicies("process", [
    effectiveToolsPolicy,
    sandbox?.tools,
    subagentPolicy,
  ]);
  const sandboxRoot = sandbox?.workspaceDir;
  const allowWorkspaceWrites = sandbox?.workspaceAccess !== "ro";
  const workspaceRoot = options?.workspaceDir ?? process.cwd();

  const base = (codingTools as unknown as AnyAgentTool[]).flatMap((tool) => {
    if (tool.name === readTool.name) {
      if (sandboxRoot) {
        return [createSandboxedReadTool(sandboxRoot)];
      }
      const freshReadTool = createReadTool(workspaceRoot);
      return [createClawdbotReadTool(freshReadTool)];
    }
    if (tool.name === bashToolName) return [];
    if (tool.name === "write") {
      if (sandboxRoot) return [];
      return [createWriteTool(workspaceRoot)];
    }
    if (tool.name === "edit") {
      if (sandboxRoot) return [];
      return [createEditTool(workspaceRoot)];
    }
    return [tool as AnyAgentTool];
  });
  const bashTool = createBashTool({
    ...options?.bash,
    cwd: options?.workspaceDir,
    allowBackground,
    scopeKey,
    sandbox: sandbox
      ? {
          containerName: sandbox.containerName,
          workspaceDir: sandbox.workspaceDir,
          containerWorkdir: sandbox.containerWorkdir,
          env: sandbox.docker.env,
        }
      : undefined,
  });
  const processTool = createProcessTool({
    cleanupMs: options?.bash?.cleanupMs,
    scopeKey,
  });
  const tools: AnyAgentTool[] = [
    ...base,
    ...(sandboxRoot
      ? allowWorkspaceWrites
        ? [
            createSandboxedEditTool(sandboxRoot),
            createSandboxedWriteTool(sandboxRoot),
          ]
        : []
      : []),
    bashTool as unknown as AnyAgentTool,
    processTool as unknown as AnyAgentTool,
    createWhatsAppLoginTool(),
    ...createClawdbotTools({
      browserControlUrl: sandbox?.browser?.controlUrl,
      agentSessionKey: options?.sessionKey,
      agentProvider: resolveGatewayMessageProvider(options?.messageProvider),
      agentAccountId: options?.agentAccountId,
      agentDir: options?.agentDir,
      sandboxed: !!sandbox,
      config: options?.config,
      currentChannelId: options?.currentChannelId,
      currentThreadTs: options?.currentThreadTs,
      replyToMode: options?.replyToMode,
      hasRepliedRef: options?.hasRepliedRef,
    }),
  ];
  const toolsFiltered = effectiveToolsPolicy
    ? filterToolsByPolicy(tools, effectiveToolsPolicy)
    : tools;
  const sandboxed = sandbox
    ? filterToolsByPolicy(toolsFiltered, sandbox.tools)
    : toolsFiltered;
  const subagentFiltered = subagentPolicy
    ? filterToolsByPolicy(sandboxed, subagentPolicy)
    : sandboxed;
  // Always normalize tool JSON Schemas before handing them to pi-agent/pi-ai.
  // Without this, some providers (notably OpenAI) will reject root-level union schemas.
  const normalized = subagentFiltered.map(normalizeToolParameters);
  const withAbort = options?.abortSignal
    ? normalized.map((tool) =>
        wrapToolWithAbortSignal(tool, options.abortSignal),
      )
    : normalized;

  // NOTE: Keep canonical (lowercase) tool names here.
  // pi-ai's Anthropic OAuth transport remaps tool names to Claude Code-style names
  // on the wire and maps them back for tool dispatch.
  return withAbort;
}
