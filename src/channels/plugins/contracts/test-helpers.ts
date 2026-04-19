import { expect, type Mock } from "vitest";
import type { MsgContext } from "../../../auto-reply/templating.js";
import { normalizeChatType } from "../../chat-type.js";
import { resolveConversationLabel } from "../../conversation-label.js";
import { validateSenderIdentity } from "../../sender-identity.js";

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper preserves channel send mock arg types.
export function primeChannelOutboundSendMock<TArgs extends unknown[]>(
  sendMock: Mock<(...args: TArgs) => Promise<unknown>>,
  fallbackResult: Record<string, unknown>,
  sendResults: Record<string, unknown>[] = [],
) {
  sendMock.mockReset();
  if (sendResults.length === 0) {
    sendMock.mockResolvedValue(fallbackResult as never);
    return;
  }
  for (const result of sendResults) {
    sendMock.mockResolvedValueOnce(result as never);
  }
}

export function expectChannelInboundContextContract(ctx: MsgContext) {
  expect(validateSenderIdentity(ctx)).toEqual([]);

  expect(ctx.Body).toBeTypeOf("string");
  expect(ctx.BodyForAgent).toBeTypeOf("string");
  expect(ctx.BodyForCommands).toBeTypeOf("string");

  const chatType = normalizeChatType(ctx.ChatType);
  if (chatType && chatType !== "direct") {
    const label = ctx.ConversationLabel?.trim() || resolveConversationLabel(ctx);
    expect(label).toBeTruthy();
  }
}
