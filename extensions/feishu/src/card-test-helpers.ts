import { expect } from "vitest";

type MockCalls = {
  mock: { calls: unknown[][] };
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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
    const card = asRecord(asRecord(arg)?.card);
    const body = asRecord(card?.body);
    return asArray(body?.elements).some((element) => {
      const elementRecord = asRecord(element);
      if (elementRecord?.tag !== "action") {
        return false;
      }
      return asArray(elementRecord.actions).some((action) => {
        const actionRecord = asRecord(action);
        const value = asRecord(actionRecord?.value);
        const command = asRecord(value?.c);
        return command?.t === "p2p";
      });
    });
  });
  expect(hasP2pAction).toBe(true);
}
