// A browser Gateway client owns authoritative question outcomes across live UI projections.
import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  type GatewayProtocolRequestOptions,
} from "@openclaw/gateway-client/browser";
import type { QuestionResolvedEvent } from "@openclaw/gateway-protocol";

export type QuestionClient = {
  request: (
    method: string,
    params?: unknown,
    options?: GatewayProtocolRequestOptions,
  ) => Promise<unknown>;
};

export type QuestionClientResolutionOwner = {
  client: QuestionClient | null;
  clientGeneration: number;
  onQuestionResolution: (resolution: QuestionResolvedEvent) => void;
};

const resolutionOwnersByClient = new WeakMap<QuestionClient, Set<QuestionClientResolutionOwner>>();

export function registerQuestionClientOwner(
  client: QuestionClient,
  owner: QuestionClientResolutionOwner,
): void {
  let owners = resolutionOwnersByClient.get(client);
  if (!owners) {
    owners = new Set();
    resolutionOwnersByClient.set(client, owners);
  }
  owners.add(owner);
}

export function unregisterQuestionClientOwner(
  client: QuestionClient,
  owner: QuestionClientResolutionOwner,
): void {
  const owners = resolutionOwnersByClient.get(client);
  if (!owners) {
    return;
  }
  owners.delete(owner);
  if (owners.size === 0) {
    resolutionOwnersByClient.delete(client);
  }
}

export function publishQuestionClientResolution(
  client: QuestionClient,
  resolution: QuestionResolvedEvent,
): void {
  const owners = resolutionOwnersByClient.get(client);
  if (!owners) {
    return;
  }
  // A listener can synchronously reconnect another pane. Snapshot its original
  // generation so an old answer never crosses into the new connection lifecycle.
  const publication = Array.from(owners, (owner) => ({
    owner,
    generation: owner.clientGeneration,
  }));
  for (const { owner, generation } of publication) {
    if (owners.has(owner) && owner.client === client && owner.clientGeneration === generation) {
      owner.onQuestionResolution(resolution);
    }
  }
}

export function requestQuestionGateway(
  client: QuestionClient,
  method: "question.list" | "question.get" | "question.resolve",
  params: unknown,
  expiresAtMs?: number,
): Promise<unknown> {
  // Browser RPCs are otherwise unbounded; decisions must also stop once their
  // prompt can no longer be settled so its interaction never remains locked.
  const timeoutMs =
    expiresAtMs === undefined
      ? DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS
      : Math.min(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS, Math.max(0, expiresAtMs - Date.now()));
  return client.request(method, params, { timeoutMs });
}
