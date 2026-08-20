import { WebClient } from "@slack/web-api";
import { describe, expect, it } from "vitest";
import { resolveSlackListenerEventScope } from "./event-scope.js";

const identity = { kind: "enterprise", apiAppId: "A123", enterpriseId: "E123" } as const;
const client = new WebClient("listener-token");

describe("resolveSlackListenerEventScope", () => {
  it.each(["T111", "workspace/Mixed Case"])(
    "preserves authorized workspace %s in the same org",
    (teamId) => {
      const listenerClient = new WebClient(`listener-token-${teamId.toLowerCase()}`);
      const result = resolveSlackListenerEventScope({
        identity,
        body: { api_app_id: "A123" },
        context: { isEnterpriseInstall: true, enterpriseId: "E123", teamId },
        client: listenerClient,
      });
      expect(result).toMatchObject({
        teamId,
        client: listenerClient,
      });
      expect(result?.client).toBe(listenerClient);
      expect(result?.uploadCompletionClient).toBeInstanceOf(WebClient);
      expect(result?.uploadCompletionClient).not.toBe(listenerClient);
    },
  );

  it("accepts a Bolt-authenticated payload that does not carry api_app_id", () => {
    const result = resolveSlackListenerEventScope({
      identity,
      body: {},
      context: { isEnterpriseInstall: true, enterpriseId: "E123", teamId: "T111" },
      client,
    });
    expect(result).toMatchObject({
      teamId: "T111",
      client,
    });
  });

  it("relies on WebClient team scoping instead of adding team_id to method payloads", async () => {
    let encodedRequestBody = "";
    const teamScopedClient = new WebClient("xoxb-test", {
      teamId: "T111",
      retryConfig: { retries: 0 },
      fetch: (_input, init) => {
        encodedRequestBody = typeof init?.body === "string" ? init.body : "";
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, ts: "123.456", channel: "C123" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    });
    const methodPayload = { channel: "C123", text: "hello" };
    const postChatMessage = teamScopedClient.chat.postMessage.bind(teamScopedClient.chat);

    await postChatMessage(methodPayload);

    expect(methodPayload).not.toHaveProperty("team_id");
    expect(new URLSearchParams(encodedRequestBody).get("team_id")).toBe("T111");
  });

  it.each([
    ["wrong app", { body: { api_app_id: "A999" } }, "wrong_app"],
    ["wrong org", { context: { enterpriseId: "E999" } }, "wrong_enterprise"],
    ["missing team", { context: { teamId: undefined } }, "missing_team_id"],
    ["missing client", { client: undefined }, "missing_listener_client"],
  ] as const)("rejects %s", (_label, override, reason) => {
    const baseContext = {
      isEnterpriseInstall: true,
      enterpriseId: "E123",
      teamId: "T111",
    };
    let droppedReason: string | undefined;
    const result = resolveSlackListenerEventScope({
      identity,
      body: { api_app_id: "A123" },
      client,
      ...override,
      context: {
        ...baseContext,
        ...("context" in override ? override.context : {}),
      },
      onDrop: (value) => {
        droppedReason = value;
      },
    });
    expect(result).toBeNull();
    expect(droppedReason).toBe(reason);
  });

  it("rejects enterprise events for workspace and degraded accounts", () => {
    for (const workspaceIdentity of [
      { kind: "workspace", apiAppId: "A123", teamId: "T111" } as const,
      { kind: "degraded", reason: "auth_test_failed" } as const,
    ]) {
      let droppedReason: string | undefined;
      expect(
        resolveSlackListenerEventScope({
          identity: workspaceIdentity,
          body: { api_app_id: "A123" },
          context: { isEnterpriseInstall: true, enterpriseId: "E123", teamId: "T111" },
          client,
          onDrop: (value) => {
            droppedReason = value;
          },
        }),
      ).toBeNull();
      expect(droppedReason).toBe("enterprise_event_for_workspace_account");
    }
  });
});
