import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { lookupTelegramChatId } from "./api-fetch.js";
import { telegramPlugin } from "./channel.js";

vi.mock("./api-fetch.js", () => ({
  lookupTelegramChatId: vi.fn(),
}));

describe("telegram target resolution", () => {
  it("uses configured runtime routing for a channel username lookup", async () => {
    const lookupMock = vi.mocked(lookupTelegramChatId);
    lookupMock.mockResolvedValue("-1001234567890");

    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          botToken: "123456:ABC-DEF",
          proxy: "http://my-proxy",
          apiRoot: "https://my-api-root",
        },
      },
    };

    const resolveTargets = telegramPlugin.resolver?.resolveTargets;
    if (!resolveTargets) {
      throw new Error("expected Telegram target resolver");
    }

    const results = await resolveTargets({
      cfg,
      accountId: "default",
      inputs: ["@testchannel"],
      // Generic target detection classifies @names before Telegram resolves the chat type.
      kind: "user",
      runtime: createNonExitingRuntimeEnv(),
    });

    expect(results).toEqual([
      {
        input: "@testchannel",
        resolved: true,
        id: "-1001234567890",
        name: "@testchannel",
      },
    ]);

    expect(lookupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        proxyUrl: "http://my-proxy",
        apiRoot: "https://my-api-root",
      }),
    );
  });
});
