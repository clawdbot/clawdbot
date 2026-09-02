import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createQaBusState, startQaBusServer } from "../../qa-lab/bus-api.js";
import { sendQaChannelMediaBatch } from "./outbound.js";

describe("QA media delivery limits", () => {
  it.each(["channel", "account", "default-account", "agent"] as const)(
    "rejects an oversized batch before publishing with the %s cap",
    async (scope) => {
      const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "qa-media-cap-")));
      const small = path.join(directory, "small.txt");
      const large = path.join(directory, "large.txt");
      const state = createQaBusState();
      const bus = await startQaBusServer({ state });
      try {
        await writeFile(small, "a".repeat(512));
        await writeFile(large, "b".repeat(1536));
        const capMb = 1 / 1024;
        const cfg = {
          agents: { defaults: { mediaMaxMb: scope === "agent" ? capMb : 10 } },
          channels: {
            "qa-channel": {
              baseUrl: bus.baseUrl,
              ...(scope === "channel" ? { mediaMaxMb: capMb } : {}),
              ...(scope === "account" || scope === "default-account"
                ? { mediaMaxMb: 10, accounts: { Limited: { mediaMaxMb: capMb } } }
                : {}),
              ...(scope === "default-account" ? { defaultAccount: "limited" } : {}),
            },
          },
        };
        const params = {
          cfg,
          accountId:
            scope === "default-account" ? undefined : scope === "account" ? "limited" : "default",
          to: "channel:media-proof",
          text: "attachment batch",
          toolCalls: [{ name: "image" }],
          mediaLocalRoots: [directory],
        };
        await expect(
          sendQaChannelMediaBatch({ ...params, mediaUrls: [small, large] }),
        ).rejects.toThrow(/exceeds.*limit/i);
        expect(state.getSnapshot().messages).toEqual([]);

        await sendQaChannelMediaBatch({ ...params, mediaUrls: [small] });
        const delivered = state.getSnapshot().messages;
        expect(delivered).toHaveLength(1);
        expect(delivered[0]?.accountId).toBe(params.accountId ?? "limited");
        expect(delivered[0]?.toolCalls).toEqual([{ name: "image" }]);
        expect(delivered[0]?.attachments?.[0]?.contentBase64).toBe(
          Buffer.from("a".repeat(512)).toString("base64"),
        );
        if (scope === "default-account") {
          await expect(
            sendQaChannelMediaBatch({ ...params, accountId: null, mediaUrls: [large] }),
          ).rejects.toThrow(/exceeds.*limit/i);
          await sendQaChannelMediaBatch({ ...params, accountId: "default", mediaUrls: [large] });
          expect(state.getSnapshot().messages.at(-1)?.accountId).toBe("default");
          expect(state.getSnapshot().messages.at(-1)?.attachments?.[0]?.contentBase64).toBe(
            Buffer.from("b".repeat(1536)).toString("base64"),
          );
        }
      } finally {
        await bus.stop();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
