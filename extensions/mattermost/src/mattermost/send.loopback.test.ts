import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { sendMessageMattermost } from "./send.js";

vi.mock("../runtime.js", () => ({
  getMattermostRuntime: () => createPluginRuntimeMock(),
}));

const USER_ID = "abcdefghijklmnopqrstuvwxyz";
const BOT_ID = "bcdefghijklmnopqrstuvwxyza";
const CHANNEL_ID = "cdefghijklmnopqrstuvwxyzab";

describe("Mattermost send target policy over real HTTP", () => {
  it("resolves cold and warm bare users with the selected account policy", async () => {
    const requests: Array<{ path: string; body: unknown; authorization?: string }> = [];
    await withServer(
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          const body = raw
            ? (JSON.parse(raw) as { channel_id?: string; message?: string })
            : undefined;
          const requestPath = request.url ?? "";
          requests.push({ path: requestPath, body, authorization: request.headers.authorization });
          response.setHeader("content-type", "application/json");
          if (requestPath === `/api/v4/users/${USER_ID}`) {
            response.end(JSON.stringify({ id: USER_ID }));
          } else if (requestPath === "/api/v4/users/me") {
            response.end(JSON.stringify({ id: BOT_ID }));
          } else if (requestPath === "/api/v4/channels/direct") {
            response.end(JSON.stringify({ id: CHANNEL_ID, type: "D" }));
          } else if (requestPath === "/api/v4/posts" && body?.channel_id === CHANNEL_ID) {
            response.end(JSON.stringify({ id: "post-1", message: body.message }));
          } else {
            response.writeHead(400);
            response.end(JSON.stringify({ message: "Unknown channel" }));
          }
        });
      },
      async (baseUrl) => {
        const cfg = {
          channels: {
            mattermost: {
              accounts: {
                selected: {
                  baseUrl,
                  botToken: "synthetic-selected",
                  network: { dangerouslyAllowPrivateNetwork: true },
                },
                restricted: { baseUrl, botToken: "synthetic-selected" },
              },
            },
          },
        };
        for (const target of [USER_ID, USER_ID, `user:${USER_ID}`, `channel:${CHANNEL_ID}`]) {
          const result = await sendMessageMattermost(target, "target proof", {
            cfg,
            accountId: "selected",
          });
          expect(result).toMatchObject({ messageId: "post-1", channelId: CHANNEL_ID });
        }
        expect(requests.map(({ path }) => path)).toEqual([
          `/api/v4/users/${USER_ID}`,
          "/api/v4/users/me",
          "/api/v4/channels/direct",
          "/api/v4/posts",
          "/api/v4/posts",
          "/api/v4/posts",
          "/api/v4/posts",
        ]);
        expect(requests.find(({ path }) => path === "/api/v4/channels/direct")?.body).toEqual([
          BOT_ID,
          USER_ID,
        ]);
        expect(
          requests.every(({ authorization }) => authorization === "Bearer synthetic-selected"),
        ).toBe(true);

        const count = requests.length;
        for (const target of [
          USER_ID,
          "defghijklmnopqrstuvwxyzabc",
          `user:${USER_ID}`,
          `channel:${CHANNEL_ID}`,
        ]) {
          await expect(
            sendMessageMattermost(target, "blocked", { cfg, accountId: "restricted" }),
          ).rejects.toThrow();
        }
        expect(requests).toHaveLength(count);
      },
    );
  });
});
