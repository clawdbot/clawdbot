import type {
  OpenClawPluginApi,
  PluginHookChannelParticipationCandidate,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const candidates: [
  PluginHookChannelParticipationCandidate,
  PluginHookChannelParticipationCandidate,
] = [
  {
    accountId: "bob",
    agentId: "research",
    participantId: "@bob:example.org",
    name: "Bob",
  },
  {
    accountId: "alice",
    agentId: "main",
    participantId: "@alice:example.org",
    name: "Alice",
  },
];
const event = { message: "Alice, could you explain that?", candidates };
const context = { channelId: "matrix", conversationId: "!room:example.org" };

function setup(text = '{"accountId":"alice"}') {
  const complete = vi.fn<OpenClawPluginApi["runtime"]["llm"]["complete"]>().mockResolvedValue({
    text,
    provider: "test-provider",
    model: "test-model",
    agentId: "main",
    usage: {},
    execution: { mode: "direct-provider", owner: { kind: "provider", id: "test-provider" } },
    audit: { caller: { kind: "plugin", id: "agent-participation" } },
  });
  const on = vi.fn<OpenClawPluginApi["on"]>();
  const api = createTestPluginApi({ id: "agent-participation", on });
  api.runtime.llm = { complete, acquireLocalService: vi.fn() };
  plugin.register(api);
  const registration = on.mock.calls.find(([name]) => name === "before_channel_participation");
  if (!registration) {
    throw new Error("Participation hook was not registered");
  }
  const handler = registration[1] as Parameters<typeof api.on<"before_channel_participation">>[1];
  return { complete, handler };
}

describe("agent participation", () => {
  it("requires explicit enablement", () => {
    expect(manifest.enabledByDefault).toBe(false);
    expect(plugin.configSchema.safeParse?.({ model: "other-model" }).success).toBe(false);
  });

  it("selects an admitted account using only the message and public candidate identities", async () => {
    const { complete, handler } = setup();

    await expect(handler(event, context)).resolves.toEqual({ accountIds: ["alice"] });

    expect(complete).toHaveBeenCalledOnce();
    const request = complete.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      maxTokens: 128,
      reasoning: "off",
      signal: expect.any(AbortSignal),
    });
    expect(request).not.toHaveProperty("model");
    expect(request).not.toHaveProperty("agentId");
    expect(JSON.parse(request!.messages[0].content)).toEqual({
      message: event.message,
      candidates: [
        { accountId: "alice", agentId: "main", name: "Alice" },
        { accountId: "bob", agentId: "research", name: "Bob" },
      ],
    });
  });

  it.each([
    '{"accountId":null}',
    '{"accountId":"unknown"}',
    '{"accountId":""}',
    '{"accountId":["alice"]}',
    '{"accountId":"alice","reason":"trust me"}',
    '[{"accountId":"alice"}]',
    '```json\n{"accountId":"alice"}\n```',
    "not JSON",
    "null",
  ])("preserves ordinary activation for unaccepted output %s", async (text) => {
    const { handler } = setup(text);
    await expect(handler(event, context)).resolves.toBeUndefined();
  });

  it("rejects oversized output even when it contains an otherwise valid decision", async () => {
    const { handler } = setup(" ".repeat(512) + '{"accountId":"alice"}');
    await expect(handler(event, context)).resolves.toBeUndefined();
  });

  it("abstains before inference when identities would exceed the prompt budget", async () => {
    const { complete, handler } = setup();
    await expect(
      handler(
        { ...event, candidates: [{ ...candidates[0], accountId: "x".repeat(3_500) }] },
        context,
      ),
    ).resolves.toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it("leaves completion failures to core's recorded fallback", async () => {
    const { complete, handler } = setup();
    const unavailable = new Error("Completion unavailable");
    complete.mockRejectedValueOnce(unavailable);
    await expect(handler(event, context)).rejects.toBe(unavailable);
    expect(complete).toHaveBeenCalledOnce();
  });
});
