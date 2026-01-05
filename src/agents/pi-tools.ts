import type { AgentTool, AgentToolResult } from "@mariozechner/pi-ai";
import { codingTools, readTool } from "@mariozechner/pi-coding-agent";
import { type TSchema, Type } from "@sinclair/typebox";

import { detectMime } from "../media/mime.js";
import { startWebLoginWithQr, waitForWebLogin } from "../web/login-qr.js";
import {
  type BashToolDefaults,
  createBashTool,
  createProcessTool,
  type ProcessToolDefaults,
} from "./bash-tools.js";
import { createClawdisTools } from "./clawdis-tools.js";
import { sanitizeToolResultImages } from "./tool-images.js";

// TODO(steipete): Remove this wrapper once pi-mono ships file-magic MIME detection
// for `read` image payloads in `@mariozechner/pi-coding-agent` (then switch back to `codingTools` directly).
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

type AnyAgentTool = AgentTool<TSchema, unknown>;

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
  if ("type" in schema && "properties" in schema) return tool;
  if (!Array.isArray(schema.anyOf)) return tool;
  const mergedProperties: Record<string, unknown> = {};
  const requiredCounts = new Map<string, number>();
  let objectVariants = 0;

  for (const entry of schema.anyOf) {
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

  return {
    ...tool,
    parameters: {
      ...schema,
      type: "object",
      properties:
        Object.keys(mergedProperties).length > 0
          ? mergedProperties
          : (schema.properties ?? {}),
      ...(mergedRequired && mergedRequired.length > 0
        ? { required: mergedRequired }
        : {}),
      additionalProperties:
        "additionalProperties" in schema ? schema.additionalProperties : true,
    } as unknown as TSchema,
  };
}

function createWhatsAppLoginTool(): AnyAgentTool {
  return {
    label: "WhatsApp Login",
    name: "whatsapp_login",
    description:
      "Generate a WhatsApp QR code for linking, or wait for the scan to complete.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("wait")]),
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

function createClawdisReadTool(base: AnyAgentTool): AnyAgentTool {
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

export function createClawdisCodingTools(options?: {
  bash?: BashToolDefaults & ProcessToolDefaults;
}): AnyAgentTool[] {
  const bashToolName = "bash";
  const base = (codingTools as unknown as AnyAgentTool[]).flatMap((tool) => {
    if (tool.name === readTool.name) return [createClawdisReadTool(tool)];
    if (tool.name === bashToolName) return [];
    return [tool as AnyAgentTool];
  });
  const bashTool = createBashTool(options?.bash);
  const processTool = createProcessTool({
    cleanupMs: options?.bash?.cleanupMs,
  });
  const tools: AnyAgentTool[] = [
    ...base,
    bashTool as unknown as AnyAgentTool,
    processTool as unknown as AnyAgentTool,
    createWhatsAppLoginTool(),
    ...createClawdisTools(),
    createWebSearchTool(),
  ];
  return tools.map(normalizeToolParameters);
}

// Global map to track tool calls across requests (per-process)
const GLOBAL_TOOL_CALL_TRACKER = new Map<string, { count: number; ts: number }>();
const MAX_TOOL_CALLS_PER_MINUTE = 10;
const TOOL_CALL_WINDOW_MS = 60000; // 1 minute

function checkAndIncrementToolCall(toolName: string): boolean {
  const now = Date.now();
  const key = `${toolName}`;
  
  // Clean up old entries
  for (const [k, data] of GLOBAL_TOOL_CALL_TRACKER.entries()) {
    if (now - data.ts > TOOL_CALL_WINDOW_MS) {
      GLOBAL_TOOL_CALL_TRACKER.delete(k);
    }
  }
  
  const data = GLOBAL_TOOL_CALL_TRACKER.get(key) || { count: 0, ts: now };
  
  // Reset if window expired
  if (now - data.ts > TOOL_CALL_WINDOW_MS) {
    data.count = 0;
    data.ts = now;
  }
  
  data.count += 1;
  GLOBAL_TOOL_CALL_TRACKER.set(key, data);
  
  return data.count <= MAX_TOOL_CALLS_PER_MINUTE;
}

export function createWebSearchTool(): AnyAgentTool {
  return {
    name: "web_search",
    description: "Search the web for current information. Use when user asks about recent events, current data, or explicitly says 'google', 'search', or 'find'. Always returns results in Russian.",
    parameters: Type.Object({
      query: Type.String({
        description: "The search query to look up on the web",
        examples: ["weather in Moscow today", "latest news about AI", "who won the world cup 2022"],
      }),
    }),
    execute: async ({ query }: { query: string }) => {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);
      const logger = console; // Simple logger for debugging
      
      try {
        // Loop protection
        if (!checkAndIncrementToolCall('web_search')) {
          logger.error(`[web_search] Loop detected: called >${MAX_TOOL_CALLS_PER_MINUTE} times in ${TOOL_CALL_WINDOW_MS/1000}s`);
          return {
            content: [
              { type: "text", text: "❌ Превышен лимит вызовов web_search (защита от бесконечного цикла)" },
            ],
          };
        }
        
        // Validate query
        if (!query || query === 'undefined') {
          logger.error(`[web_search] Invalid query: "${query}"`);
          return {
            content: [
              { type: "text", text: "❌ Ошибка: пустой запрос для поиска" },
            ],
          };
        }
        
        logger.log(`[web_search] Executing search for: "${query}"`);
        
        // Use the project's google_web CLI
        const cliPath = "/home/almaz/zoo_flow/clawdis/google_web";
        const command = `${cliPath} ${JSON.stringify(query)}`;
        logger.log(`[web_search] Command: ${command}`);
        
        const { stdout, stderr } = await execAsync(command, {
          timeout: 60000, // Increased from 30s to 60s
          env: process.env,
        });
        
        if (stderr) {
          logger.warn(`[web_search] CLI stderr: ${stderr}`);
        }
        
        const trimmed = stdout.trim();
        logger.log(`[web_search] Raw output length: ${trimmed.length}`);
        
        const result = JSON.parse(trimmed);
        logger.log(`[web_search] Parsed result, has response: ${!!result.response}`);
        
        if (result.response) {
          return {
            content: [
              { type: "text", text: `🌐 Результат поиска:\n${result.response}` },
            ],
          };
        }
        
        return {
          content: [
            { type: "text", text: "❌ Поиск не дал результатов" },
          ],
        };
      } catch (error) {
        const errorStr = String(error);
        logger.error(`[web_search] Error: ${errorStr}`);
        
        if (errorStr.includes("timeout")) {
          return {
            content: [
              { type: "text", text: "⏱️ Поиск занял слишком много времени" },
            ],
          };
        }
        
        // Include more error details for debugging
        const details = error instanceof Error && 'stdout' in error ? 
          ` (stdout: ${String((error as any).stdout).substring(0, 200)})` : '';
        
        return {
          content: [
            { type: "text", text: `❌ Ошибка при поиске: ${errorStr}${details}` },
          ],
        };
      }
    },
  } as unknown as AnyAgentTool;
}
