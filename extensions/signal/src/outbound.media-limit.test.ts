import { readFile, writeFile } from "node:fs/promises";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import { signalPlugin } from "./channel.js";
import * as client from "./client-adapter.js";

describe("Signal account media limits", () => {
  it.each(["work", undefined])("enforces the resolved account cap for %s", async (accountId) => {
    const state = await createOpenClawTestState({ prefix: "signal-account-media-" });
    const delivered: Buffer[] = [];
    const request = vi
      .spyOn(client, "signalRpcRequest")
      .mockImplementation(async (_method, params) => {
        const attachment = Array.isArray(params?.attachments) ? params.attachments[0] : undefined;
        if (typeof attachment !== "string") {
          throw new Error("Missing native attachment path");
        }
        delivered.push(await readFile(attachment));
        return { timestamp: 1234567890 };
      });
    try {
      const smallBytes = Buffer.from("%PDF-1.4\nsmall attachment");
      const largeBytes = Buffer.alloc(2 * 1024 * 1024, 0x61);
      const small = state.path("small.pdf");
      const large = state.path("large.pdf");
      await writeFile(small, smallBytes);
      await writeFile(large, largeBytes);
      const transport = { kind: "external-native" as const, url: "http://signal.test" };
      const params = {
        cfg: {
          channels: {
            signal: {
              account: "+15550001111",
              transport,
              mediaMaxMb: 8,
              defaultAccount: "work",
              accounts: { Work: { transport, mediaMaxMb: 1 } },
            },
          },
        },
        accountId,
        to: "+15555550123",
        text: "",
        mediaLocalRoots: [state.root],
      };
      const send = signalPlugin.outbound?.sendMedia;
      if (!send) {
        throw new Error("Missing Signal media sender");
      }
      await expect(send({ ...params, mediaUrl: large })).rejects.toThrow(/exceeds.*limit/i);
      expect(request).not.toHaveBeenCalled();
      const result = await send({ ...params, mediaUrl: small });
      expect(result.messageId).toBe("1234567890");
      expect(delivered).toEqual([smallBytes]);
      await send({ ...params, accountId: "default", mediaUrl: large });
      expect(delivered).toHaveLength(2);
      expect(delivered[0]?.equals(smallBytes)).toBe(true);
      expect(delivered[1]?.equals(largeBytes)).toBe(true);
    } finally {
      request.mockRestore();
      await state.cleanup();
    }
  });
});
