import { createHash, randomUUID } from "node:crypto";
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "openclaw/plugin-sdk/types";
import {
  SLUG_PATTERN,
  type OnePasswordConfig,
  type OnePasswordItemConfig,
  type OnePasswordPolicy,
} from "./config.js";
import { OnePasswordError, type OnePasswordErrorCode } from "./errors.js";
import type { OpClient, ResolvedSecret } from "./op-client.js";
import {
  AUTHORIZATION_NONCE_PARAM,
  consumeUniquePendingAuthorization,
} from "./pending-authorization.js";

type AuditOutcome =
  | "auto"
  | "approved"
  | "grant"
  | "denied"
  | "policy-denied"
  | "timeout"
  | "error"
  | "cache-hit";

export type AuditRow = {
  timestampMs: number;
  agentId: string;
  sessionKey: string;
  toolCallId: string;
  slug: string;
  reason: string;
  outcome: AuditOutcome;
  approvalId?: string;
  errorCode?: AuditErrorCode;
};

export type StandingGrant = {
  agentId: string;
  slug: string;
  grantedAtMs: number;
  expiresAtMs: number;
  targetFingerprint: string;
};

type AuditInternalErrorCode =
  | "INVALID_ACTION"
  | "INVALID_REASON"
  | "INVALID_SLUG"
  | "UNKNOWN_SLUG"
  | "TOOL_CALL_ID_MISSING"
  | "POLICY_NOT_EVALUATED"
  | "POLICY_CHANGED"
  | "GRANT_EXPIRED"
  | "APPROVAL_CANCELLED";

type AuditErrorCode = OnePasswordErrorCode | AuditInternalErrorCode;

type BrokerStores = {
  audit: PluginStateKeyedStore<AuditRow>;
  grants: PluginStateKeyedStore<StandingGrant>;
  pending: PluginStateSyncKeyedStore<PendingAuthorization>;
};

type BrokerOptions = {
  resolveConfig: () => OnePasswordConfig | undefined;
  opClient: Pick<OpClient, "getItem">;
  stores: BrokerStores;
  now?: () => number;
};

type AccessContext = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  toolCallId: string;
  slug: string;
  reason: string;
};

export type PendingAuthorization = AccessContext & {
  outcome: "auto" | "approved" | "grant";
  persistGrant: boolean;
  configFingerprint: string;
  targetFingerprint: string;
};

type CacheEntry = ResolvedSecret & {
  targetFingerprint: string;
  expiresAtMs: number;
};

type ParsedGet = {
  action: "get";
  slug: string;
  reason: string;
};

type ToolInvocationContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
};

type ParsedList = {
  action: "list";
};

type ParsedToolInput = ParsedGet | ParsedList;

type ListedItem = {
  slug: string;
  description: string;
  policy: OnePasswordPolicy;
  standingGrantActive: boolean;
};

const APPROVAL_TIMEOUT_MS = 600_000;
const PENDING_AUTHORIZATION_TTL_MS = APPROVAL_TIMEOUT_MS;

function textParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value.trim() : undefined;
}

class BrokerError extends Error {
  readonly code: AuditInternalErrorCode;

  constructor(code: AuditInternalErrorCode, message: string) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
  }
}

function internalError(code: AuditInternalErrorCode, message: string): BrokerError {
  return new BrokerError(code, message);
}

function fingerprintOnePasswordTarget(item: OnePasswordItemConfig): string {
  return createHash("sha256")
    .update(JSON.stringify([item.vault, item.item, item.field]))
    .digest("hex");
}

function standingGrantKey(agentId: string, slug: string): string {
  return createHash("sha256")
    .update(JSON.stringify([agentId, slug]))
    .digest("hex");
}

export function parseToolInput(params: Record<string, unknown>): ParsedToolInput {
  if (params.action === "list") {
    return { action: "list" };
  }
  if (params.action !== "get") {
    throw internalError("INVALID_ACTION", "action must be list or get");
  }
  const reason = textParam(params, "reason");
  if (!reason || reason.length > 300) {
    throw internalError("INVALID_REASON", "reason is required and must be at most 300 characters");
  }
  const slug = textParam(params, "slug");
  if (!slug || !SLUG_PATTERN.test(slug)) {
    throw internalError("INVALID_SLUG", "slug must match ^[a-z0-9][a-z0-9-]{0,63}$");
  }
  return { action: "get", slug, reason };
}

function errorCode(error: unknown): AuditErrorCode | undefined {
  if (error instanceof OnePasswordError) {
    return error.code;
  }
  if (error instanceof BrokerError) {
    return error.code;
  }
  return undefined;
}

export class OnePasswordBroker {
  private readonly resolveConfig: () => OnePasswordConfig | undefined;
  private readonly opClient: Pick<OpClient, "getItem">;
  private readonly stores: BrokerStores;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private lastConfigFingerprint: string | null | undefined;

  constructor(options: BrokerOptions) {
    this.resolveConfig = options.resolveConfig;
    this.opClient = options.opClient;
    this.stores = options.stores;
    this.now = options.now ?? Date.now;
  }

  private observeConfigFingerprint(fingerprint: string | null): void {
    if (this.lastConfigFingerprint !== undefined && this.lastConfigFingerprint !== fingerprint) {
      // A reload can revoke policy or retarget a slug: drop this instance's
      // cached secrets. Shared pending entries are NOT cleared here - that
      // would race sibling broker instances with stale local tracking; get()
      // rejects stale entries via their per-entry configFingerprint instead.
      this.cache.clear();
    }
    this.lastConfigFingerprint = fingerprint;
  }

  private currentConfig(): { config: OnePasswordConfig; fingerprint: string } {
    const config = this.resolveConfig();
    if (!config) {
      this.observeConfigFingerprint(null);
      throw internalError("POLICY_CHANGED", "1Password broker is no longer configured");
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(config)).digest("hex");
    this.observeConfigFingerprint(fingerprint);
    return { config, fingerprint };
  }

  private registerPending(nonce: string, authorization: PendingAuthorization): void {
    this.stores.pending.register(nonce, authorization, { ttlMs: PENDING_AUTHORIZATION_TTL_MS });
  }

  private context(
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
    input: Partial<ParsedGet>,
  ): AccessContext {
    return {
      agentId: ctx.agentId ?? "unknown",
      sessionKey: ctx.sessionKey ?? "unknown",
      sessionId: ctx.sessionId ?? "unknown",
      toolCallId: event.toolCallId ?? ctx.toolCallId ?? "unknown",
      slug: input.slug ?? "unknown",
      reason: input.reason ?? "",
    };
  }

  private async audit(
    context: AccessContext,
    outcome: AuditOutcome,
    options: { errorCode?: AuditErrorCode } = {},
  ): Promise<void> {
    const timestampMs = this.now();
    const key = `${String(timestampMs).padStart(16, "0")}:${context.toolCallId}:${randomUUID()}`;
    await this.stores.audit.register(key, {
      timestampMs,
      agentId: context.agentId,
      sessionKey: context.sessionKey,
      toolCallId: context.toolCallId,
      slug: context.slug,
      reason: context.reason,
      outcome,
      ...(options.errorCode ? { errorCode: options.errorCode } : {}),
    });
  }

  private async pruneStaleGrants(config: OnePasswordConfig): Promise<void> {
    const now = this.now();
    for (const entry of await this.stores.grants.entries()) {
      const item = Object.hasOwn(config.items, entry.value.slug)
        ? config.items[entry.value.slug]
        : undefined;
      if (
        !item ||
        entry.key !== standingGrantKey(entry.value.agentId, entry.value.slug) ||
        entry.value.expiresAtMs <= now ||
        entry.value.targetFingerprint !== fingerprintOnePasswordTarget(item)
      ) {
        await this.stores.grants.delete(entry.key);
      }
    }
  }

  async beforeToolCall(
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ): Promise<PluginHookBeforeToolCallResult | void> {
    if (event.toolName !== "onepassword") {
      return;
    }
    let input: ParsedToolInput;
    try {
      input = parseToolInput(event.params);
    } catch (error) {
      const context = this.context(event, ctx, {
        slug: textParam(event.params, "slug"),
        reason: textParam(event.params, "reason"),
      });
      await this.audit(context, "error", { errorCode: errorCode(error) ?? "INVALID_ACTION" });
      return {
        block: true,
        blockReason: error instanceof Error ? error.message : "Invalid request",
      };
    }
    if (input.action === "list") {
      return;
    }
    const context = this.context(event, ctx, input);
    let config: OnePasswordConfig;
    let configFingerprint: string;
    try {
      ({ config, fingerprint: configFingerprint } = this.currentConfig());
    } catch (error) {
      await this.audit(context, "error", { errorCode: errorCode(error) });
      return {
        block: true,
        blockReason: error instanceof Error ? error.message : "1Password broker is unavailable",
      };
    }
    if (!Object.hasOwn(config.items, input.slug)) {
      await this.audit(context, "error", { errorCode: "UNKNOWN_SLUG" });
      return { block: true, blockReason: `Unknown 1Password slug: ${input.slug}` };
    }
    const item = config.items[input.slug];
    if (!item) {
      throw new Error(`Missing 1Password config for registered slug: ${input.slug}`);
    }
    if (!event.toolCallId && !ctx.toolCallId) {
      await this.audit(context, "error", { errorCode: "TOOL_CALL_ID_MISSING" });
      return { block: true, blockReason: "1Password request is missing a tool call id" };
    }
    if (item.policy === "deny") {
      await this.audit(context, "policy-denied");
      return { block: true, blockReason: `1Password access denied by policy for ${input.slug}` };
    }

    const nonce = randomUUID();
    const authorizedParams = { ...event.params, [AUTHORIZATION_NONCE_PARAM]: nonce };
    if (item.policy === "auto") {
      this.registerPending(nonce, {
        ...context,
        outcome: "auto",
        persistGrant: false,
        configFingerprint,
        targetFingerprint: fingerprintOnePasswordTarget(item),
      });
      return { params: authorizedParams };
    }

    const grantKey =
      context.agentId === "unknown" ? undefined : standingGrantKey(context.agentId, input.slug);
    const grant = grantKey ? await this.stores.grants.lookup(grantKey) : undefined;
    if (
      grant &&
      grant.agentId === context.agentId &&
      grant.slug === input.slug &&
      grant.expiresAtMs > this.now() &&
      grant.targetFingerprint === fingerprintOnePasswordTarget(item)
    ) {
      this.registerPending(nonce, {
        ...context,
        outcome: "grant",
        persistGrant: false,
        configFingerprint,
        targetFingerprint: fingerprintOnePasswordTarget(item),
      });
      return { params: authorizedParams };
    }
    if (grant && grantKey) {
      await this.stores.grants.delete(grantKey);
    }

    return {
      params: authorizedParams,
      requireApproval: {
        title: `1Password: ${input.slug}`,
        description: `Agent ${context.agentId} requests ${input.slug}. Reason: ${input.reason}`,
        severity: "warning",
        timeoutMs: APPROVAL_TIMEOUT_MS,
        // Durable grants must bind to a concrete core-provided agent identity.
        // Unknown callers can still receive one-call approval, never shared access.
        allowedDecisions:
          context.agentId === "unknown"
            ? ["allow-once", "deny"]
            : ["allow-once", "allow-always", "deny"],
        // Core fires onResolution without awaiting it; the synchronous store write
        // below is what guarantees the authorization exists before the tool
        // handler runs. Do not move it behind an await.
        onResolution: async (decision) => {
          if (decision === "allow-once" || decision === "allow-always") {
            this.registerPending(nonce, {
              ...context,
              outcome: "approved",
              persistGrant: decision === "allow-always" && context.agentId !== "unknown",
              configFingerprint,
              targetFingerprint: fingerprintOnePasswordTarget(item),
            });
            return;
          }
          if (decision === "deny") {
            await this.audit(context, "denied");
            return;
          }
          if (decision === "timeout") {
            await this.audit(context, "timeout");
            return;
          }
          await this.audit(context, "error", { errorCode: "APPROVAL_CANCELLED" });
        },
      },
    };
  }

  async list(invocation: ToolInvocationContext): Promise<ListedItem[]> {
    const { config } = this.currentConfig();
    const grants = new Map(
      (await this.stores.grants.entries()).map((entry) => [entry.key, entry.value]),
    );
    const now = this.now();
    const agentId = invocation.agentId;
    return Object.entries(config.items)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([slug, item]) => {
        const grant = agentId ? grants.get(standingGrantKey(agentId, slug)) : undefined;
        return {
          slug,
          description: item.description ?? "",
          policy: item.policy,
          standingGrantActive: Boolean(
            grant &&
            grant.agentId === agentId &&
            grant.slug === slug &&
            grant.expiresAtMs > now &&
            grant.targetFingerprint === fingerprintOnePasswordTarget(item),
          ),
        };
      });
  }

  async get(
    toolCallId: string,
    input: ParsedGet,
    invocation: ToolInvocationContext,
    nonce: string | undefined,
  ): Promise<ResolvedSecret & { slug: string }> {
    const fallbackContext: AccessContext = {
      agentId: invocation.agentId ?? "unknown",
      sessionKey: invocation.sessionKey ?? "unknown",
      sessionId: invocation.sessionId ?? "unknown",
      toolCallId,
      slug: input.slug,
      reason: input.reason,
    };
    // A present-but-unknown nonce means forgery, replay, or a consumed entry:
    // fail closed. The identity fallback applies only when the nonce param was
    // dropped entirely by another hook's params rewrite.
    const authorization =
      nonce !== undefined
        ? this.stores.pending.consume(nonce)
        : consumeUniquePendingAuthorization(this.stores.pending, fallbackContext);
    if (
      !authorization ||
      authorization.slug !== input.slug ||
      authorization.reason !== input.reason
    ) {
      await this.audit(fallbackContext, "error", { errorCode: "POLICY_NOT_EVALUATED" });
      throw internalError(
        "POLICY_NOT_EVALUATED",
        "1Password policy was not evaluated for this request",
      );
    }

    let config: OnePasswordConfig;
    let configFingerprint: string;
    try {
      ({ config, fingerprint: configFingerprint } = this.currentConfig());
    } catch (error) {
      await this.audit(authorization, "error", { errorCode: errorCode(error) });
      throw error;
    }
    if (!Object.hasOwn(config.items, input.slug)) {
      await this.audit(authorization, "error", { errorCode: "UNKNOWN_SLUG" });
      throw internalError("UNKNOWN_SLUG", `Unknown 1Password slug: ${input.slug}`);
    }
    const item = config.items[input.slug];
    if (!item) {
      throw new Error(`Missing 1Password config for registered slug: ${input.slug}`);
    }
    if (item.policy === "deny") {
      await this.audit(authorization, "policy-denied");
      throw internalError("POLICY_CHANGED", `1Password access denied by policy for ${input.slug}`);
    }
    if (
      (authorization.outcome === "auto" && item.policy !== "auto") ||
      (authorization.outcome !== "auto" && item.policy !== "approve") ||
      authorization.configFingerprint !== configFingerprint ||
      authorization.targetFingerprint !== fingerprintOnePasswordTarget(item)
    ) {
      await this.audit(authorization, "error", { errorCode: "POLICY_CHANGED" });
      throw internalError("POLICY_CHANGED", "1Password policy changed before tool execution");
    }
    if (authorization.outcome === "grant") {
      const grant = await this.stores.grants.lookup(
        standingGrantKey(authorization.agentId, input.slug),
      );
      if (
        !grant ||
        grant.agentId !== authorization.agentId ||
        grant.slug !== input.slug ||
        grant.expiresAtMs <= this.now() ||
        grant.targetFingerprint !== fingerprintOnePasswordTarget(item)
      ) {
        await this.audit(authorization, "error", { errorCode: "GRANT_EXPIRED" });
        throw internalError(
          "GRANT_EXPIRED",
          "1Password standing grant expired before tool execution",
        );
      }
    }

    if (authorization.persistGrant) {
      const grantedAtMs = this.now();
      const ttlMs = Math.round(config.grantTtlHours * 60 * 60 * 1000);
      try {
        await this.pruneStaleGrants(config);
        await this.stores.grants.register(
          standingGrantKey(authorization.agentId, input.slug),
          {
            agentId: authorization.agentId,
            slug: input.slug,
            grantedAtMs,
            expiresAtMs: grantedAtMs + ttlMs,
            targetFingerprint: fingerprintOnePasswordTarget(item),
          },
          { ttlMs },
        );
      } catch (error) {
        await this.audit(authorization, "error", { errorCode: errorCode(error) });
        throw error;
      }
    }

    const cached = this.cache.get(input.slug);
    const targetFingerprint = fingerprintOnePasswordTarget(item);
    if (
      cached &&
      cached.expiresAtMs > this.now() &&
      cached.targetFingerprint === targetFingerprint
    ) {
      await this.audit(authorization, "cache-hit");
      return {
        slug: input.slug,
        value: cached.value,
        itemTitle: cached.itemTitle,
        fieldLabel: cached.fieldLabel,
      };
    }
    this.cache.delete(input.slug);

    try {
      const secret = await this.opClient.getItem(item);
      await this.audit(authorization, authorization.outcome);
      if (config.cacheTtlSeconds > 0) {
        this.cache.set(input.slug, {
          ...secret,
          targetFingerprint,
          expiresAtMs: this.now() + config.cacheTtlSeconds * 1000,
        });
      }
      return { slug: input.slug, ...secret };
    } catch (error) {
      await this.audit(authorization, "error", { errorCode: errorCode(error) });
      throw error;
    }
  }
}
