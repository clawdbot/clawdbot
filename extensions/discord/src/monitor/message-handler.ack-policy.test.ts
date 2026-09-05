import fs from "node:fs/promises";
import path from "node:path";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { describe, expect, it } from "vitest";
import {
  createDiscordMessageHandler,
  preflightDiscordMessageMock,
  processDiscordMessageMock,
} from "./message-handler.module-test-helpers.js";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";
import { createDiscordHandlerParams } from "./message-handler.test-helpers.js";

describe("Discord acknowledgement policy", () => {
  it.each([undefined, "off"] as const)(
    "captures current acknowledgement policy for each turn (account override: %s)",
    async (accountScope) => {
      preflightDiscordMessageMock.mockReset().mockResolvedValue(null);
      processDiscordMessageMock.mockReset();
      const params = createDiscordHandlerParams();
      params.cfg.messages = { inbound: { debounceMs: 0 }, ackReactionScope: "off" };
      params.discordConfig = { ...params.discordConfig, ackReactionScope: accountScope };
      params.cfg.channels = { discord: params.discordConfig };
      setRuntimeConfigSnapshot(params.cfg, params.cfg);
      const context = await createBaseDiscordMessageContext();
      const handler = createDiscordMessageHandler(params);
      try {
        for (const scope of ["off", "all", "off"] as const) {
          const cfg = {
            ...params.cfg,
            messages: { ...params.cfg.messages, ackReactionScope: scope },
          };
          setRuntimeConfigSnapshot(cfg, cfg);
          await handler({ ...context.data, message: context.message }, context.client);
          expect(preflightDiscordMessageMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ cfg, ackReactionScope: accountScope ?? scope }),
          );
        }
        expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(3);
      } finally {
        await handler.deactivate();
        clearRuntimeConfigSnapshot();
        await fs.rm(path.dirname(context.cfg.session!.store!), { recursive: true, force: true });
      }
    },
  );
});
