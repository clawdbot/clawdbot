import fs from "node:fs/promises";
import path from "node:path";

type BeforeToolCallEvent = { toolName: string; params: Record<string, unknown> };
type AfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
};

type ToolCtx = { agentId?: string; sessionKey?: string; toolName: string; toolCallId?: string };

type Receipt = {
  id: string;
  createdAt: string;
  agentId?: string;
  sessionKey?: string;
  toolName: string;
  params?: Record<string, unknown>;
  ok: boolean;
  error?: string;
  durationMs?: number;
};

function nowIso() {
  return new Date().toISOString();
}

function safeId() {
  // sortable, filesystem-safe
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${t}-${r}`;
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

// Minimal API shape we rely on. The real runtime passes a superset.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MinimalApi = { runtime: { stateDir: string }; pluginConfig?: any };

export function createReceiptStore(opts: { api: MinimalApi }) {
  const api = opts.api;
  const enabled = (api.pluginConfig?.enabled as boolean | undefined) ?? true;
  const includeParams = (api.pluginConfig?.includeParams as boolean | undefined) ?? true;

  const baseDir =
    (api.pluginConfig?.receiptsDir as string | undefined)?.trim() ||
    path.join(api.runtime.stateDir, "receipts");

  const pending = new Map<string, { id: string; createdAt: string; params?: Record<string, unknown> }>();

  function key(ctx: ToolCtx) {
    // Prefer per-invocation id to avoid collisions across parallel tool calls.
    return ctx.toolCallId && ctx.toolCallId.length > 0
      ? ctx.toolCallId
      : `${ctx.sessionKey ?? ""}::${ctx.toolName}`;
  }

  async function writeReceipt(receipt: Receipt) {
    const day = receipt.createdAt.slice(0, 10);
    const dir = path.join(baseDir, day);
    await ensureDir(dir);
    const file = path.join(dir, `${receipt.id}.json`);
    await fs.writeFile(file, JSON.stringify(receipt, null, 2), "utf-8");
  }

  return {
    async onBeforeToolCall(event: BeforeToolCallEvent, ctx: ToolCtx) {
      if (!enabled) return;
      const id = safeId();
      const createdAt = nowIso();
      pending.set(key(ctx), { id, createdAt, params: includeParams ? event.params : undefined });
    },

    async onAfterToolCall(event: AfterToolCallEvent, ctx: ToolCtx) {
      if (!enabled) return;
      const k = key(ctx);
      const start = pending.get(k);
      const id = start?.id ?? safeId();
      const createdAt = start?.createdAt ?? nowIso();
      pending.delete(k);

      const receipt: Receipt = {
        id,
        createdAt,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        toolName: event.toolName,
        params: start?.params,
        ok: !event.error,
        error: event.error,
        durationMs: event.durationMs
      };

      await writeReceipt(receipt);
    },

    async list(params: { limit: number; sessionKey?: string }) {
      const out: Receipt[] = [];
      try {
        const days = await fs.readdir(baseDir);
        days.sort().reverse();
        for (const day of days) {
          const dir = path.join(baseDir, day);
          const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
          files.sort().reverse();
          for (const f of files) {
            const full = path.join(dir, f);
            const txt = await fs.readFile(full, "utf-8");
            const r = JSON.parse(txt) as Receipt;
            if (params.sessionKey && r.sessionKey !== params.sessionKey) continue;
            out.push(r);
            if (out.length >= params.limit) return out;
          }
        }
      } catch {
        return out;
      }
      return out;
    },

    async read(id: string) {
      // brute-force find
      const days = await fs.readdir(baseDir);
      for (const day of days) {
        const file = path.join(baseDir, day, `${id}.json`);
        try {
          const txt = await fs.readFile(file, "utf-8");
          return JSON.parse(txt);
        } catch {
          // continue
        }
      }
      throw new Error(`receipt not found: ${id}`);
    }
  };
}
