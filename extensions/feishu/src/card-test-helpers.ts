import { asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
// Feishu helper module supports card test helpers behavior.
import { expect } from "vitest";

type MockCalls = {
  mock: { calls: unknown[][] };
};

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readFeishuObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? asRecord(value) : undefined;
}

export function expectFirstSentCardUsesFillWidthOnly(sendCardMock: {
  mock: { calls: unknown[][] };
}) {
  const firstSendArg = sendCardMock.mock.calls.at(0)?.[0] as
    | {
        card?: {
          config?: {
            width_mode?: string;
            wide_screen_mode?: boolean;
            enable_forward?: boolean;
          };
        };
      }
    | undefined;
  const sentCard = firstSendArg?.card;
  expect(sentCard).toBeDefined();
  expect(sentCard?.config?.width_mode).toBe("fill");
  expect(sentCard?.config?.wide_screen_mode).toBeUndefined();
  expect(sentCard?.config?.enable_forward).toBeUndefined();
}

export function expectSentCardHasP2pAction(sendCardMock: MockCalls) {
  const hasP2pAction = sendCardMock.mock.calls.some(([arg]) => {
    const card = readFeishuObjectRecord(readFeishuObjectRecord(arg)?.card);
    const body = readFeishuObjectRecord(card?.body);
    return asArray(body?.elements).some((element) => {
      const elementRecord = readFeishuObjectRecord(element);
      if (elementRecord?.tag !== "action") {
        return false;
      }
      return asArray(elementRecord.actions).some((action) => {
        const actionRecord = readFeishuObjectRecord(action);
        const value = readFeishuObjectRecord(actionRecord?.value);
        const command = readFeishuObjectRecord(value?.c);
        return command?.t === "p2p";
      });
    });
  });
  expect(hasP2pAction).toBe(true);
}
