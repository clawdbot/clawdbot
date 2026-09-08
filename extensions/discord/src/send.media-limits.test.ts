import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { sendMessageDiscord } from "./send.js";
import { createDiscordLoopbackRest } from "./send.test-harness.js";

const CASES: Array<{
  label: string;
  cfg: OpenClawConfig;
  accountId?: string;
  document?: string;
  accepted: boolean;
}> = [
  {
    label: "fractional channel cap",
    cfg: { channels: { discord: { mediaMaxMb: 30.1 } } },
    accepted: true,
  },
  {
    label: "selected account cap",
    cfg: {
      channels: {
        discord: { mediaMaxMb: 0.1 / (1024 * 1024), accounts: { work: { mediaMaxMb: 30.1 } } },
      },
    },
    accountId: "work",
    accepted: true,
  },
  {
    label: "channel default ignoring the agent cap",
    cfg: { agents: { defaults: { mediaMaxMb: 0.1 / (1024 * 1024) } }, channels: { discord: {} } },
    accepted: true,
  },
  {
    label: "sub-byte cap",
    cfg: { channels: { discord: { mediaMaxMb: 0.1 / (1024 * 1024) } } },
    document: "%",
    accepted: false,
  },
];

describe("Discord configured limits on physical uploads", () => {
  it.each(CASES)("preserves the $label", async (testCase) => {
    await withTempHome(async (home) => {
      const mediaRoot = await fs.realpath(home);
      const mediaPath = path.join(mediaRoot, "limit.pdf");
      const document = testCase.document ?? "%PDF-1.4\nconfigured media limit\n%%EOF\n";
      await fs.writeFile(mediaPath, document);
      const loopback = await createDiscordLoopbackRest();
      try {
        // 30.1 MiB exceeds normal image optimization headroom; no loader mode is forced.
        const sending = sendMessageDiscord("channel:789", "document", {
          cfg: testCase.cfg,
          accountId: testCase.accountId,
          token: "test-token-placeholder",
          rest: loopback.rest,
          mediaUrl: mediaPath,
          mediaLocalRoots: [mediaRoot],
        });
        if (!testCase.accepted) {
          await expect(sending).rejects.toThrow(/exceeds|too large/i);
          expect(loopback.requests.filter(({ method }) => method === "POST")).toHaveLength(0);
          return;
        }
        expect((await sending).messageId).toBe("loopback-message");
        const uploads = loopback.requests.filter(({ method }) => method === "POST");
        expect(uploads).toHaveLength(1);
        const upload = uploads[0];
        const form = await new Response(upload?.body, {
          headers: { "content-type": upload?.contentType ?? "" },
        }).formData();
        const file = form.get("files[0]");
        if (!file || typeof file === "string") {
          throw new Error("Discord upload omitted files[0]");
        }
        expect(await file.text()).toBe(document);
      } finally {
        await loopback.close();
      }
    });
  });
});
