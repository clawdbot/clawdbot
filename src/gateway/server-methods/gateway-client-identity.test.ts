import { describe, expect, it } from "vitest";
import { ControlUiGitHubError } from "../control-ui-github-api.js";
import {
  authenticatedProfileUnavailableError,
  gatewayClientSenderFields,
  gatewayClientSessionCreator,
} from "./gateway-client-identity.js";
import type { GatewayClient } from "./types.js";

describe("gateway client identity", () => {
  it("surfaces the sanitized upstream rate-limit delay", () => {
    const error = new ControlUiGitHubError(429, "private upstream detail", {
      retryAfterMs: 42_000,
    });

    expect(authenticatedProfileUnavailableError(error)).toEqual({
      code: "UNAVAILABLE",
      message: "Authenticated profile verification is unavailable; retry the request.",
      retryable: true,
      retryAfterMs: 42_000,
      details: { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" },
    });
  });

  it("overrides sender attribution without replacing the authorizing identity", () => {
    const client = {
      authenticatedUserProfile: {
        profileId: "owner",
        displayName: "Owner",
        hasAvatar: false,
        updatedAt: 1,
      },
      internal: {
        syntheticClient: true,
        senderAttribution: { id: "alice", name: "Suggested by Alice" },
      },
    } as GatewayClient;

    expect(gatewayClientSessionCreator(client)).toEqual({
      type: "human",
      id: "owner",
      label: "Owner",
    });
    expect(gatewayClientSenderFields(client)).toEqual({
      sender: { id: "alice", name: "Suggested by Alice" },
    });
  });

  it("keeps a GitHub-backed mutable alias unattributed until immutable sync completes", () => {
    const client = {
      authenticatedUserId: "released-login@github",
      authenticatedGitHubIdentitySync: async () => ({ profileId: "owner", updatedAt: 1 }),
    } as GatewayClient;

    expect(gatewayClientSenderFields(client)).toEqual({});
    expect(gatewayClientSessionCreator(client)).toBeUndefined();
  });
});
