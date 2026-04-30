import { expect, type Mock } from "vitest";
import type { DispatchFromConfigResult } from "../../../auto-reply/reply/dispatch-from-config.types.js";
import type { MsgContext } from "../../../auto-reply/templating.js";
import { normalizeChatType } from "../../chat-type.js";
import { resolveConversationLabel } from "../../conversation-label.js";
import { validateSenderIdentity } from "../../sender-identity.js";
import {
  hasFinalChannelTurnDispatch,
  hasVisibleChannelTurnDispatch,
  resolveChannelTurnDispatchCounts,
  type ChannelTurnDispatchResultLike,
} from "../../turn/dispatch-result.js";

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

export function expectChannelTurnDispatchResultContract(
  result: ChannelTurnDispatchResultLike,
  expected: {
    visible: boolean;
    final?: boolean;
    counts?: Partial<DispatchFromConfigResult["counts"]>;
  },
) {
  expect(hasVisibleChannelTurnDispatch(result)).toBe(expected.visible);
  if (expected.final !== undefined) {
    expect(hasFinalChannelTurnDispatch(result)).toBe(expected.final);
  }
  if (expected.counts) {
    expect(resolveChannelTurnDispatchCounts(result)).toMatchObject(expected.counts);
  }
}
