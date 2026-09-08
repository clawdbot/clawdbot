// Tests /loop recognition, work-order rewriting, authorization, and interval guards.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { handleLoopCommand } from "./commands-loop.js";
import type { HandleCommandsParams } from "./commands-types.js";

function buildLoopParams(commandBodyNormalized: string): HandleCommandsParams {
  return {
    cfg: {},
    ctx: {
      Provider: INTERNAL_MESSAGE_CHANNEL,
      Surface: INTERNAL_MESSAGE_CHANNEL,
      CommandSource: "text",
      Body: commandBodyNormalized,
      RawBody: commandBodyNormalized,
      CommandBody: commandBodyNormalized,
      BodyForCommands: commandBodyNormalized,
      BodyForAgent: commandBodyNormalized,
      BodyStripped: commandBodyNormalized,
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "tester",
      channel: INTERNAL_MESSAGE_CHANNEL,
      channelId: INTERNAL_MESSAGE_CHANNEL,
      surface: INTERNAL_MESSAGE_CHANNEL,
      ownerList: [],
      rawBodyNormalized: commandBodyNormalized,
    },
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:webchat:test",
    workspaceDir: "/tmp",
    provider: "openai",
    model: "gpt-5.6",
    contextTokens: 0,
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

function rewrittenBody(params: HandleCommandsParams): string {
  return (params.ctx as { BodyForAgent?: string }).BodyForAgent ?? "";
}

// Mirrors the handler's conversation tag for the fixture sessionKey.
const LOOP_PREFIX = `loop[${createHash("sha256").update("agent:main:webchat:test").digest("hex").slice(0, 12)}]`;

describe("loop command", () => {
  it("ignores non-loop text", async () => {
    expect(await handleLoopCommand(buildLoopParams("check ci"), true)).toBeNull();
  });

  it("returns usage for bare /loop without continuing", async () => {
    const result = await handleLoopCommand(buildLoopParams("/loop"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe(
      "Usage: /loop [interval] <prompt> — repeat a prompt in this chat (e.g. /loop 5m check deploy status). Without interval the loop self-paces between 1m and 1h. /loop status lists loops; /loop stop [name] stops.",
    );
  });

  it("rewrites a fixed interval loop as a current-session cron job", async () => {
    const params = buildLoopParams("/loop 5m check ci");

    expect(await handleLoopCommand(params, true)).toEqual({ shouldContinue: true });
    expect(rewrittenBody(params)).toContain('schedule:{kind:"every",everyMs:300000}');
    expect(rewrittenBody(params)).toContain('sessionTarget:"current"');
    expect(rewrittenBody(params)).toContain(`"${LOOP_PREFIX} check ci"`);
    expect(rewrittenBody(params)).toContain("do not use the message tool");
    // Loop work orders are model-facing prompts: they must teach the canonical
    // automations tool, never the legacy cron alias (RFC 0026).
    expect(rewrittenBody(params)).toContain("with the automations tool");
    expect(rewrittenBody(params)).not.toMatch(/\bcron tool\b/);
  });

  it("preserves parseDurationMs unitless millisecond intervals", async () => {
    const params = buildLoopParams("/loop 30000 check ci");

    expect(await handleLoopCommand(params, true)).toEqual({ shouldContinue: true });
    expect(rewrittenBody(params)).toContain('schedule:{kind:"every",everyMs:30000}');
  });

  it("rewrites an interval-free loop with pacing and next_check guidance", async () => {
    const params = buildLoopParams("/loop watch for new github issues");

    expect(await handleLoopCommand(params, true)).toEqual({ shouldContinue: true });
    expect(rewrittenBody(params)).toContain('pacing:{min:"1m",max:"1h"}');
    expect(rewrittenBody(params)).toContain('action:\\"next_check\\"');
    expect(rewrittenBody(params)).toContain('in:\\"<duration>\\"');
  });

  it("rewrites /loop status as a conversation-scoped list work order", async () => {
    const params = buildLoopParams("/loop status");

    expect(await handleLoopCommand(params, true)).toEqual({ shouldContinue: true });
    expect(rewrittenBody(params)).toContain('action:"list", includeDisabled:true');
    expect(rewrittenBody(params)).toContain(`name starts with "${LOOP_PREFIX}"`);
    expect(rewrittenBody(params)).toContain("Use the automations tool");
    expect(rewrittenBody(params)).not.toMatch(/\bcron\b/i);
  });

  it("rewrites /loop stop as a scoped cron removal work order", async () => {
    const params = buildLoopParams("/loop stop");

    expect(await handleLoopCommand(params, true)).toEqual({ shouldContinue: true });
    expect(rewrittenBody(params)).toContain('action:"list", includeDisabled:true');
    expect(rewrittenBody(params)).toContain(`name starts with "${LOOP_PREFIX}"`);
    expect(rewrittenBody(params)).toContain('action:"remove"');
    expect(rewrittenBody(params)).toContain(
      `Never remove a job whose name does not start with "${LOOP_PREFIX}"`,
    );
  });

  it("rejects unauthorized senders", async () => {
    const params = buildLoopParams("/loop 5m check ci");
    params.command.isAuthorizedSender = false;

    expect(await handleLoopCommand(params, true)).toEqual({ shouldContinue: false });
    expect(rewrittenBody(params)).toBe("/loop 5m check ci");
  });

  it("rejects authorized non-owner senders before starting an agent turn", async () => {
    const params = buildLoopParams("/loop 5m check ci");
    params.command.senderIsOwner = false;

    expect(await handleLoopCommand(params, true)).toEqual({
      shouldContinue: false,
      reply: { text: expect.stringContaining("operator.admin") },
    });
    expect(rewrittenBody(params)).toBe("/loop 5m check ci");
  });

  it("rejects intervals below 30 seconds", async () => {
    const result = await handleLoopCommand(buildLoopParams("/loop 5s x"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Minimum interval 30s");
  });
});
