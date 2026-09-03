// Gateway hook mapping resolver.
// Normalizes hook presets, templates, transforms, and resolved hook actions.
import fs from "node:fs";
import path from "node:path";
import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { resolveConfigPathCandidate } from "../config/paths.js";
import type { HookMappingConfig, HooksConfig, HookSessionMode } from "../config/types.hooks.js";
import { resolveGmailHookMaxBytes } from "../hooks/gmail.js";
import { importFileModule, resolveFunctionModuleExport } from "../hooks/module-loader.js";
import { isPathInside } from "../infra/path-guards.js";
import type { HookMessageChannel } from "./hooks.types.js";

export type HookMappingResolved = {
  id: string;
  matchPath?: string;
  matchSource?: string;
  action: "wake" | "agent";
  wakeMode?: "now" | "next-heartbeat";
  name?: string;
  agentId?: string;
  sessionKey?: string;
  sessionMode?: HookSessionMode;
  messageTemplate?: string;
  textTemplate?: string;
  deliver?: boolean;
  allowUnsafeExternalContent?: boolean;
  channel?: HookMessageChannel;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  transform?: HookMappingTransformResolved;
  forEach?: string;
  /** Path-scoped request body bound derived from the producer contract (e.g. gog gmail batches). */
  maxBodyBytes?: number;
};

type HookMappingTransformResolved = {
  modulePath: string;
  exportName?: string;
};

type HookMappingContext = {
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  url: URL;
  path: string;
};

type HookAction =
  | {
      kind: "wake";
      mappingId: string;
      text: string;
      mode: "now" | "next-heartbeat";
      agentId?: string;
      sessionKey?: string;
      sessionKeySource?: "static" | "templated";
    }
  | {
      kind: "agent";
      mappingId: string;
      message: string;
      name?: string;
      agentId?: string;
      wakeMode: "now" | "next-heartbeat";
      sessionKey?: string;
      sessionKeySource?: "static" | "templated";
      sessionMode: HookSessionMode;
      deliver?: boolean;
      allowUnsafeExternalContent?: boolean;
      channel?: HookMessageChannel;
      to?: string;
      model?: string;
      thinking?: string;
      timeoutSeconds?: number;
    };

type HookSessionKeyTemplateSource = "static" | "templated";

type HookMappingResult =
  | { ok: true; actions: HookAction[]; fanout: boolean; dropped: number }
  | { ok: false; error: string };

// Bounded fan-out: gog gmail watch serve batches at most ~100 messages per push
// (gogcli defaultHistoryMaxResults); anything beyond 2x that contract is a
// pathological payload whose tail is dropped with a recorded reason instead of
// spawning unbounded agent runs from one authenticated request.
export const HOOK_MAPPING_FAN_OUT_MAX_ITEMS = 200;

// Body bound for gmail-path hooks, derived from the producer contract OpenClaw
// itself provisions: gog posts up to 100 history records per push (gogcli
// internal/cmd/gmail_watch_types.go defaultHistoryMaxResults) with each body
// truncated to hooks.gmail.maxBytes. Reserve JSON-escaping (up to ~3x for
// escaped control chars) plus header/snippet/label overhead per message. A
// rejected batch is never retried smaller: gog rewinds its history cursor and
// Pub/Sub redelivers the same batch forever, so undersizing this bound wedges
// inbound mail permanently (#120278).
const GMAIL_HOOK_BATCH_MAX_MESSAGES = 100;
const GMAIL_HOOK_JSON_ESCAPING_FACTOR = 3;
const GMAIL_HOOK_PER_MESSAGE_OVERHEAD_BYTES = 8 * 1024;
// Hard ceiling on the derived allowance: hooks.gmail.maxBytes is
// operator-controlled and unbounded, and the batch multiplier would otherwise
// amplify a large-but-valid setting into a hundreds-of-megabytes in-memory
// request buffer for authenticated callers. 32 MiB covers ~100 KB per-message
// settings; larger configs fall back to this bound.
const GMAIL_HOOK_MAX_BODY_BYTES_CEILING = 32 * 1024 * 1024;

function resolveGmailHookMaxBodyBytes(maxBytes: number): number {
  return Math.min(
    GMAIL_HOOK_MAX_BODY_BYTES_CEILING,
    GMAIL_HOOK_BATCH_MAX_MESSAGES *
      (maxBytes * GMAIL_HOOK_JSON_ESCAPING_FACTOR + GMAIL_HOOK_PER_MESSAGE_OVERHEAD_BYTES),
  );
}

const hookPresetMappings: Record<string, HookMappingConfig[]> = {
  gmail: [
    {
      id: "gmail",
      match: { path: "gmail" },
      action: "agent",
      wakeMode: "now",
      name: "Gmail",
      // forEach dispatches one isolated run per pushed message; the templates
      // below render against a payload holding only the current message, so
      // messages[0] means "this message", not "the first of the batch".
      forEach: "messages",
      sessionKey: "hook:gmail:{{messages[0].id}}",
      messageTemplate:
        "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",
    },
  ],
};

const transformCache = new Map<string, HookTransformFn>();
let transformCacheBustVersion = 0;

export function commitHookTransformMappingReload(): void {
  transformCache.clear();
  transformCacheBustVersion += 1;
}

type HookTransformResult = Partial<{
  kind: HookAction["kind"];
  text: string;
  mode: "now" | "next-heartbeat";
  message: string;
  agentId: string;
  wakeMode: "now" | "next-heartbeat";
  name: string;
  sessionKey: string;
  sessionKeySource: HookSessionKeyTemplateSource;
  sessionMode: HookSessionMode;
  deliver: boolean;
  allowUnsafeExternalContent: boolean;
  channel: HookMessageChannel;
  to: string;
  model: string;
  thinking: string;
  timeoutSeconds: number;
}> | null;

type HookTransformFn = (
  ctx: HookMappingContext,
) => HookTransformResult | Promise<HookTransformResult>;

/** Resolve configured hook mappings plus preset mappings into normalized matcher entries. */
export function resolveHookMappings(
  hooks?: HooksConfig,
  opts?: { configDir?: string },
): HookMappingResolved[] {
  const presets = hooks?.presets ?? [];
  const gmailAllowUnsafe = hooks?.gmail?.allowUnsafeExternalContent;
  const mappings: HookMappingConfig[] = [];
  if (hooks?.mappings) {
    mappings.push(...hooks.mappings);
  }
  for (const preset of presets) {
    const presetMappings = hookPresetMappings[preset];
    if (!presetMappings) {
      continue;
    }
    if (preset === "gmail" && typeof gmailAllowUnsafe === "boolean") {
      mappings.push(
        ...presetMappings.map((mapping) => ({
          ...mapping,
          allowUnsafeExternalContent: gmailAllowUnsafe,
        })),
      );
      continue;
    }
    mappings.push(...presetMappings);
  }
  if (mappings.length === 0) {
    return [];
  }

  const configDir = path.resolve(opts?.configDir ?? path.dirname(resolveConfigPathCandidate()));
  const transformsRootDir = path.join(configDir, "hooks", "transforms");
  const transformsDir = resolveOptionalContainedPath(
    transformsRootDir,
    hooks?.transformsDir,
    "Hook transformsDir",
  );

  const gmailMaxBodyBytes = resolveGmailHookMaxBodyBytes(
    resolveGmailHookMaxBytes(hooks?.gmail?.maxBytes),
  );
  return mappings.map((mapping, index) => {
    const normalized = normalizeHookMapping(mapping, index, transformsDir);
    // Every gmail-path mapping (preset or the documented custom restricted
    // reader) receives gog's batch payloads, so all of them inherit the
    // producer-derived body bound.
    if (normalized.matchPath === "gmail") {
      normalized.maxBodyBytes = gmailMaxBodyBytes;
    }
    return normalized;
  });
}

export async function applyHookMappings(
  mappings: HookMappingResolved[],
  ctx: HookMappingContext,
): Promise<HookMappingResult | null> {
  if (mappings.length === 0) {
    return null;
  }
  for (const mapping of mappings) {
    if (!mappingMatches(mapping, ctx)) {
      continue;
    }
    if (mapping.forEach) {
      return await applyFanOutMapping(mapping, mapping.forEach, ctx);
    }
    const single = await applyMappingToContext(mapping, ctx);
    if (!single.ok) {
      return single;
    }
    return {
      ok: true,
      actions: single.action ? [single.action] : [],
      fanout: false,
      dropped: 0,
    };
  }
  return null;
}

type HookMappingItemResult = { ok: true; action: HookAction | null } | { ok: false; error: string };

async function applyMappingToContext(
  mapping: HookMappingResolved,
  ctx: HookMappingContext,
): Promise<HookMappingItemResult> {
  const base = buildActionFromMapping(mapping, ctx);
  if (!base.ok) {
    return base;
  }

  let override: HookTransformResult = null;
  if (mapping.transform) {
    const transform = await loadTransform(mapping.transform);
    override = await transform(ctx);
    if (override === null) {
      return { ok: true, action: null };
    }
  }

  if (!base.action) {
    return { ok: true, action: null };
  }
  return mergeAction(base.action, override, mapping.action);
}

async function applyFanOutMapping(
  mapping: HookMappingResolved,
  forEachKey: string,
  ctx: HookMappingContext,
): Promise<HookMappingResult> {
  const raw = ctx.payload[forEachKey];
  const allItems = Array.isArray(raw) ? raw : [];
  const items = allItems.slice(0, HOOK_MAPPING_FAN_OUT_MAX_ITEMS);
  const actions: HookAction[] = [];
  for (const item of items) {
    // Each item renders against a payload where the fan-out array holds only
    // that item, so single-message templates like {{messages[0].id}} keep
    // working per item and transforms see a per-item payload.
    const itemCtx: HookMappingContext = {
      ...ctx,
      payload: { ...ctx.payload, [forEachKey]: [item] },
    };
    const result = await applyMappingToContext(mapping, itemCtx);
    if (!result.ok) {
      // A render/validation failure is a mapping bug affecting the whole
      // batch; failing it keeps the producer retrying visibly instead of
      // silently dropping the item.
      return result;
    }
    if (result.action) {
      actions.push(result.action);
    }
  }
  return {
    ok: true,
    actions,
    fanout: true,
    dropped: allItems.length - items.length,
  };
}

function normalizeHookMapping(
  mapping: HookMappingConfig,
  index: number,
  transformsDir: string,
): HookMappingResolved {
  const id = normalizeOptionalString(mapping.id) || `mapping-${index + 1}`;
  const matchPath = normalizeHookMatchPath(mapping.match?.path);
  const matchSource = mapping.match?.source?.trim();
  const action = mapping.action ?? "agent";
  const wakeMode = mapping.wakeMode ?? "now";
  const forEach = normalizeForEachKey(mapping.forEach);
  const transform = mapping.transform
    ? {
        modulePath: resolveContainedPath(transformsDir, mapping.transform.module, "Hook transform"),
        exportName: normalizeOptionalString(mapping.transform.export),
      }
    : undefined;

  return {
    id,
    matchPath,
    matchSource,
    action,
    wakeMode,
    forEach,
    name: mapping.name,
    agentId: normalizeOptionalString(mapping.agentId),
    sessionKey: mapping.sessionKey,
    sessionMode: mapping.sessionMode,
    messageTemplate: mapping.messageTemplate,
    textTemplate: mapping.textTemplate,
    deliver: mapping.deliver,
    allowUnsafeExternalContent: mapping.allowUnsafeExternalContent,
    channel: mapping.channel,
    to: mapping.to,
    model: mapping.model,
    thinking: mapping.thinking,
    timeoutSeconds: mapping.timeoutSeconds,
    transform,
  };
}

function normalizeForEachKey(raw: string | undefined): string | undefined {
  const key = normalizeOptionalString(raw);
  if (!key) {
    return undefined;
  }
  // Fan-out replaces one top-level payload key with a single-item array per
  // dispatch; nested paths would require rebuilding arbitrary object graphs.
  if (/[.[\]]/.test(key) || BLOCKED_PATH_KEYS.has(key)) {
    throw new Error(`Hook mapping forEach must be a top-level payload key: ${raw}`);
  }
  return key;
}

function mappingMatches(mapping: HookMappingResolved, ctx: HookMappingContext) {
  if (mapping.matchPath) {
    if (mapping.matchPath !== normalizeHookMatchPath(ctx.path)) {
      return false;
    }
  }
  if (mapping.matchSource) {
    const source = readStringValue(ctx.payload.source);
    if (!source || source !== mapping.matchSource) {
      return false;
    }
  }
  return true;
}

function buildActionFromMapping(
  mapping: HookMappingResolved,
  ctx: HookMappingContext,
): HookMappingItemResult {
  if (mapping.action === "wake") {
    const text = renderTemplate(mapping.textTemplate ?? "", ctx);
    return {
      ok: true,
      action: {
        kind: "wake",
        mappingId: mapping.id,
        text,
        mode: mapping.wakeMode ?? "now",
        agentId: mapping.agentId,
        sessionKey: renderOptional(mapping.sessionKey, ctx),
        sessionKeySource: getSessionKeyTemplateSource(mapping.sessionKey),
      },
    };
  }
  const message = renderTemplate(mapping.messageTemplate ?? "", ctx);
  return {
    ok: true,
    action: {
      kind: "agent",
      mappingId: mapping.id,
      message,
      name: renderOptional(mapping.name, ctx),
      agentId: mapping.agentId,
      wakeMode: mapping.wakeMode ?? "now",
      sessionKey: renderOptional(mapping.sessionKey, ctx),
      sessionKeySource: getSessionKeyTemplateSource(mapping.sessionKey),
      sessionMode: mapping.sessionMode ?? "isolated",
      deliver: mapping.deliver,
      allowUnsafeExternalContent: mapping.allowUnsafeExternalContent,
      channel: mapping.channel,
      to: renderOptional(mapping.to, ctx),
      model: renderOptional(mapping.model, ctx),
      thinking: renderOptional(mapping.thinking, ctx),
      timeoutSeconds: mapping.timeoutSeconds,
    },
  };
}

function mergeAction(
  base: HookAction,
  override: HookTransformResult,
  defaultAction: "wake" | "agent",
): HookMappingItemResult {
  if (!override) {
    return validateAction(base);
  }
  const kind = override.kind ?? base.kind ?? defaultAction;
  if (kind === "wake") {
    const baseWake = base.kind === "wake" ? base : undefined;
    const text = typeof override.text === "string" ? override.text : (baseWake?.text ?? "");
    const mode = override.mode === "next-heartbeat" ? "next-heartbeat" : (baseWake?.mode ?? "now");
    return validateAction({
      kind: "wake",
      mappingId: base.mappingId,
      text,
      mode,
      agentId: override.agentId ?? baseWake?.agentId,
      sessionKey: override.sessionKey ?? baseWake?.sessionKey,
      sessionKeySource: resolveMergedSessionKeySource(baseWake, override),
    });
  }
  const baseAgent = base.kind === "agent" ? base : undefined;
  const message =
    typeof override.message === "string" ? override.message : (baseAgent?.message ?? "");
  const wakeMode =
    override.wakeMode === "next-heartbeat" ? "next-heartbeat" : (baseAgent?.wakeMode ?? "now");
  return validateAction({
    kind: "agent",
    mappingId: base.mappingId,
    message,
    wakeMode,
    name: override.name ?? baseAgent?.name,
    agentId: override.agentId ?? baseAgent?.agentId,
    sessionKey: override.sessionKey ?? baseAgent?.sessionKey,
    sessionKeySource: resolveMergedSessionKeySource(baseAgent, override),
    sessionMode: override.sessionMode ?? baseAgent?.sessionMode ?? "isolated",
    deliver: typeof override.deliver === "boolean" ? override.deliver : baseAgent?.deliver,
    allowUnsafeExternalContent:
      typeof override.allowUnsafeExternalContent === "boolean"
        ? override.allowUnsafeExternalContent
        : baseAgent?.allowUnsafeExternalContent,
    channel: override.channel ?? baseAgent?.channel,
    to: override.to ?? baseAgent?.to,
    model: override.model ?? baseAgent?.model,
    thinking: override.thinking ?? baseAgent?.thinking,
    timeoutSeconds: override.timeoutSeconds ?? baseAgent?.timeoutSeconds,
  });
}

function validateAction(action: HookAction): HookMappingItemResult {
  if (action.sessionKeySource === "templated" && !action.sessionKey?.trim()) {
    return { ok: false, error: "hook mapping sessionKey template rendered empty" };
  }
  if (action.kind === "wake") {
    if (!action.text?.trim()) {
      return { ok: false, error: "hook mapping requires text" };
    }
    if (action.mode === "next-heartbeat" && action.sessionKey) {
      return {
        ok: false,
        error: "hook mapping sessionKey requires wakeMode=now",
      };
    }
    return { ok: true, action };
  }
  if (!action.message?.trim()) {
    return { ok: false, error: "hook mapping requires message" };
  }
  if (action.sessionMode !== "isolated" && action.sessionMode !== "persistent") {
    return { ok: false, error: "hook mapping sessionMode must be isolated or persistent" };
  }
  return { ok: true, action };
}

function getSessionKeyTemplateSource(
  sessionKeyTemplate: string | undefined,
): HookSessionKeyTemplateSource | undefined {
  const normalizedTemplate = normalizeOptionalString(sessionKeyTemplate);
  if (!normalizedTemplate) {
    return undefined;
  }
  return hasHookTemplateExpressions(normalizedTemplate) ? "templated" : "static";
}

function resolveMergedSessionKeySource(
  baseAction: HookAction | undefined,
  override: Exclude<HookTransformResult, null>,
): HookSessionKeyTemplateSource | undefined {
  if (typeof override.sessionKey === "string") {
    const normalizedSessionKey = normalizeOptionalString(override.sessionKey);
    if (!normalizedSessionKey) {
      // Empty transform overrides behave like an absent sessionKey and fall
      // through to the default/generated key path later in hook dispatch.
      return undefined;
    }
    return override.sessionKeySource === "static" ? "static" : "templated";
  }
  return baseAction?.sessionKeySource;
}

export function hasHookTemplateExpressions(template: string): boolean {
  return /\{\{\s*[^}]+\s*\}\}/.test(template);
}

async function loadTransform(transform: HookMappingTransformResolved): Promise<HookTransformFn> {
  const cacheKey = `${transform.modulePath}::${transform.exportName ?? "default"}`;
  const cached = transformCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const generation = transformCacheBustVersion;
  const mod = await importFileModule({
    modulePath: transform.modulePath,
    cacheBust: true,
    nowMs: generation,
  });
  const fn = resolveTransformFn(mod, transform.exportName);
  if (generation === transformCacheBustVersion) {
    transformCache.set(cacheKey, fn);
  }
  return fn;
}

function resolveTransformFn(mod: Record<string, unknown>, exportName?: string): HookTransformFn {
  const candidate = resolveFunctionModuleExport<HookTransformFn>({
    mod,
    exportName,
    fallbackExportNames: ["default", "transform"],
  });
  if (!candidate) {
    throw new Error("hook transform module must export a function");
  }
  return candidate;
}

function resolvePath(baseDir: string, target: string): string {
  if (!target) {
    return path.resolve(baseDir);
  }
  return path.isAbsolute(target) ? path.resolve(target) : path.resolve(baseDir, target);
}

function safeRealpathSync(candidate: string): string | null {
  try {
    // Hook containment prefers native canonicalization when Node exposes it.
    // Keep the plain fallback only for runtimes without the native entrypoint.
    const nativeRealpath = fs.realpathSync.native as ((path: string) => string) | undefined;
    return nativeRealpath ? nativeRealpath(candidate) : fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

function resolveExistingAncestor(candidate: string): string | null {
  let current = path.resolve(candidate);
  while (true) {
    if (fs.existsSync(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveContainedPath(baseDir: string, target: string, label: string): string {
  const base = path.resolve(baseDir);
  const trimmed = target?.trim();
  if (!trimmed) {
    throw new Error(`${label} module path is required`);
  }
  const resolved = resolvePath(base, trimmed);
  if (!isPathInside(base, resolved)) {
    throw new Error(`${label} module path must be within ${base}: ${target}`);
  }

  // Block symlink escapes for existing path segments while preserving current
  // behavior for not-yet-created files.
  const baseRealpath = safeRealpathSync(base);
  const existingAncestor = resolveExistingAncestor(resolved);
  const existingAncestorRealpath = existingAncestor ? safeRealpathSync(existingAncestor) : null;
  if (
    baseRealpath &&
    existingAncestorRealpath &&
    !isPathInside(baseRealpath, existingAncestorRealpath)
  ) {
    throw new Error(`${label} module path must be within ${base}: ${target}`);
  }
  return resolved;
}

function resolveOptionalContainedPath(
  baseDir: string,
  target: string | undefined,
  label: string,
): string {
  const trimmed = target?.trim();
  if (!trimmed) {
    return path.resolve(baseDir);
  }
  return resolveContainedPath(baseDir, trimmed, label);
}

export function normalizeHookMatchPath(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}

function renderOptional(value: string | undefined, ctx: HookMappingContext) {
  if (!value) {
    return undefined;
  }
  const rendered = renderTemplate(value, ctx).trim();
  return rendered ? rendered : undefined;
}

function renderTemplate(template: string, ctx: HookMappingContext) {
  if (!template) {
    return "";
  }
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, expr: string) => {
    const value = resolveTemplateExpr(expr.trim(), ctx);
    if (value === undefined || value === null) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return JSON.stringify(value);
  });
}

function resolveTemplateExpr(expr: string, ctx: HookMappingContext) {
  if (expr === "path") {
    return ctx.path;
  }
  if (expr === "now") {
    return new Date().toISOString();
  }
  if (expr.startsWith("headers.")) {
    return getByPath(ctx.headers, expr.slice("headers.".length));
  }
  if (expr.startsWith("query.")) {
    return getByPath(
      Object.fromEntries(ctx.url.searchParams.entries()),
      expr.slice("query.".length),
    );
  }
  if (expr.startsWith("payload.")) {
    return getByPath(ctx.payload, expr.slice("payload.".length));
  }
  return getByPath(ctx.payload, expr);
}

// Block traversal into prototype-chain properties on attacker-controlled
// webhook payloads.  Mirrors the same blocklist used by config-paths.ts
// for config path traversal.
const BLOCKED_PATH_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function getByPath(input: Record<string, unknown>, pathExpr: string): unknown {
  if (!pathExpr) {
    return undefined;
  }
  const parts: Array<string | number> = [];
  const re = /([^.[\]]+)|(\[(\d+)\])/g;
  let match = re.exec(pathExpr);
  while (match) {
    if (match[1]) {
      parts.push(match[1]);
    } else if (match[3]) {
      parts.push(Number(match[3]));
    }
    match = re.exec(pathExpr);
  }
  let current: unknown = input;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof part === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[part] as unknown;
      continue;
    }
    if (BLOCKED_PATH_KEYS.has(part)) {
      return undefined;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
