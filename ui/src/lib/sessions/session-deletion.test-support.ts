import { vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";
import type { SessionDeleteOutcome } from "./session-capability.ts";

function row(name: string): GatewaySessionRow {
  return { key: `agent:main:${name}`, sessionId: `id-${name}`, kind: "direct", updatedAt: 1 };
}

export function createSessionDeletionHarness() {
  const alpha = row("alpha");
  const beta = row("beta");
  const sibling = row("sibling");
  const responses = new Map<string, ReturnType<typeof createDeferred<SessionDeleteOutcome>>>();
  let serverRows = [alpha, beta, sibling];
  let listResponse: Promise<SessionsListResult> | undefined;
  const request = vi.fn(
    async (method: string, params?: { key?: string; limit?: number; offset?: number }) => {
      if (method === "sessions.delete") {
        const response = createDeferred<SessionDeleteOutcome>();
        responses.set(params!.key!, response);
        return response.promise;
      }
      if (method === "sessions.list") {
        const offset = params?.offset ?? 0;
        return (
          listResponse ?? {
            ...sessionsResult(
              serverRows.slice(offset, offset + (params?.limit ?? serverRows.length)),
              1,
            ),
            totalCount: serverRows.length,
          }
        );
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      throw new Error(`Unexpected request: ${method}`);
    },
  );
  const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  const sessions = createSessionCapability(gateway.gateway);
  return {
    ...gateway,
    sessions,
    alpha,
    beta,
    sibling,
    responses,
    request,
    setRows: (rows: GatewaySessionRow[]) => {
      serverRows = rows;
    },
    setListResponse: (response?: Promise<SessionsListResult>) => {
      listResponse = response;
    },
  };
}
