import { expect } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import type { installMockGateway } from "../test-helpers/control-ui-e2e.ts";

export const sharedPublisher = { source: "system-configured", accountId: 1, login: "system-bot" };
export const personalAccount = { accountId: 2, login: "alice-tools" };
export const personalGeneration = "8c698e8a-bdc7-4927-a0f2-73a842c2d7b1";
export const publicationOptions = {
  shared: sharedPublisher,
  personal: {
    state: "connected",
    generation: personalGeneration,
    account: personalAccount,
    accessExpiresAtMs: null,
    refreshState: "available",
    pending: null,
  },
  pendingPersonal: null,
};
export const publicationMethods = [
  "chat.metadata",
  "chat.startup",
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  "sessions.github.publish",
  "sessions.github.options",
  "sessions.github.status",
  "sessions.github.confirm",
];

export async function showPublicationBranch(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  branch = "openclaw/personal-publication",
) {
  const key = await waitForWatchedSessionKey(gateway);
  await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
    sessions: {
      [key]: {
        pullRequests: [],
        branch: { owner: "openclaw", repo: "openclaw", branch, additions: 7, deletions: 2 },
        rateLimited: false,
        status: "ok",
      },
    },
  });
}

export async function waitForWatchedSessionKey(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
): Promise<string> {
  let watchedKey = "";
  await expect
    .poll(async () => {
      const requests = await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
      for (const request of requests.toReversed()) {
        const params = request.params;
        if (!params || typeof params !== "object" || !("sessionKeys" in params)) {
          continue;
        }
        const keys = (params as { sessionKeys?: unknown }).sessionKeys;
        if (Array.isArray(keys) && typeof keys[0] === "string") {
          watchedKey = keys[0];
          break;
        }
      }
      return watchedKey;
    })
    .not.toBe("");
  return watchedKey;
}
