import { expect } from "vitest";

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

export function expectSentCardHasP2pAction(sendCardMock: unknown) {
  expect(sendCardMock).toHaveBeenCalledWith(
    expect.objectContaining({
      card: expect.objectContaining({
        body: expect.objectContaining({
          elements: expect.arrayContaining([
            expect.objectContaining({
              tag: "action",
              actions: expect.arrayContaining([
                expect.objectContaining({
                  value: expect.objectContaining({
                    c: expect.objectContaining({
                      t: "p2p",
                    }),
                  }),
                }),
              ]),
            }),
          ]),
        }),
      }),
    }),
  );
}
