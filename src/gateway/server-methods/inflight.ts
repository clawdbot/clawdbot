import type { ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

export type GatewayInflightResult = {
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
  meta?: Record<string, unknown>;
};

const inflightByContext = new WeakMap<
  GatewayRequestContext,
  Map<string, Promise<GatewayInflightResult>>
>();

function getInflightMap(context: GatewayRequestContext) {
  let inflight = inflightByContext.get(context);
  if (!inflight) {
    inflight = new Map();
    inflightByContext.set(context, inflight);
  }
  return inflight;
}

/** Joins concurrent idempotent requests and replays completed Gateway dedupe entries. */
export function resolveGatewayInflightRequest(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  idempotencyKey: string;
  respond: RespondFn;
}):
  | {
      kind: "ready";
      idem: string;
      dedupeKey: string;
      inflightMap: Map<string, Promise<GatewayInflightResult>>;
    }
  | {
      kind: "handled";
      done: Promise<void>;
    } {
  // Persistent dedupe wins before process-local in-flight joins for idempotent retries.
  const cached = params.context.dedupe.get(params.dedupeKey);
  if (cached) {
    params.respond(cached.ok, cached.payload, cached.error, { cached: true });
    return { kind: "handled", done: Promise.resolve() };
  }
  const inflightMap = getInflightMap(params.context);
  const inflight = inflightMap.get(params.dedupeKey);
  if (inflight) {
    return {
      kind: "handled",
      done: inflight.then((result) => {
        const meta = result.meta ? { ...result.meta, cached: true } : { cached: true };
        params.respond(result.ok, result.payload, result.error, meta);
      }),
    };
  }
  return {
    kind: "ready",
    idem: params.idempotencyKey,
    dedupeKey: params.dedupeKey,
    inflightMap,
  };
}

export async function runGatewayInflightWork(params: {
  inflightMap: Map<string, Promise<GatewayInflightResult>>;
  dedupeKey: string;
  work: Promise<GatewayInflightResult>;
  respond: RespondFn;
}) {
  params.inflightMap.set(params.dedupeKey, params.work);
  try {
    const result = await params.work;
    params.respond(result.ok, result.payload, result.error, result.meta);
  } finally {
    params.inflightMap.delete(params.dedupeKey);
  }
}

export function cacheGatewayDedupeResult(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  requestIdentity?: string;
  result: Pick<GatewayInflightResult, "ok" | "payload" | "error">;
}) {
  params.context.dedupe.set(params.dedupeKey, {
    ts: Date.now(),
    ok: params.result.ok,
    ...(params.requestIdentity ? { requestIdentity: params.requestIdentity } : {}),
    ...(params.result.payload !== undefined ? { payload: params.result.payload } : {}),
    ...(params.result.error ? { error: params.result.error } : {}),
  });
}
