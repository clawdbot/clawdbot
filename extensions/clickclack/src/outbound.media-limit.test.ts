import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { sendClickClackMedia } from "./outbound.js";

describe("ClickClack media limits at the upload boundary", () => {
  it.each([false, true])(
    "bounds source bytes before platform writes (durable=%s)",
    async (durable) => {
      const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "clickclack-cap-")));
      const file = path.join(directory, "attachment.txt");
      const writes: string[] = [];
      try {
        await withServer(
          (request, response) => {
            request.resume();
            request.on("end", () => {
              const url = request.url ?? "";
              if (request.method === "GET") {
                response.writeHead(404, { "X-ClickClack-Upload-Nonce": "supported" });
                response.end();
                return;
              }
              writes.push(url);
              response.writeHead(200, { "content-type": "application/json" });
              response.end(
                JSON.stringify(
                  url.startsWith("/api/uploads?")
                    ? { upload: { id: "upl_cap", filename: "attachment.txt" } }
                    : { message: { id: "msg_cap" }, ok: true },
                ),
              );
            });
          },
          async (baseUrl) => {
            const params = {
              cfg: {
                channels: {
                  clickclack: {
                    baseUrl,
                    token: "fixture",
                    workspace: "wsp_cap",
                    mediaMaxMb: 10,
                    accounts: { Limited: { mediaMaxMb: 1 / 1024 } },
                  },
                },
              },
              accountId: "limited",
              to: "channel:chn_cap",
              text: "attachment",
              mediaUrl: file,
              mediaLocalRoots: [directory],
              ...(durable ? { deliveryQueueId: "cap-proof", deliveryPartIndex: 0 } : {}),
            };
            await writeFile(file, "x".repeat(1536));
            await expect(sendClickClackMedia(params)).rejects.toThrow(/exceeds.*limit/i);
            expect(writes).toEqual([]);
            await writeFile(file, "x".repeat(512));
            await expect(sendClickClackMedia(params)).resolves.toBe("msg_cap");
            expect(writes).toHaveLength(3);
            expect(writes[0]).toMatch(/^\/api\/uploads\?/);
            expect(writes[2]).toBe("/api/messages/msg_cap/attachments");
          },
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
