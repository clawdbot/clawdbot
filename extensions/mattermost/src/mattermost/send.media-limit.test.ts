import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { setMattermostRuntime } from "../runtime.js";
import { sendMessageMattermost } from "./send.js";

describe("Mattermost media limits at the upload boundary", () => {
  it("rejects oversized source bytes without uploading or falling back to a text post", async () => {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "mattermost-cap-")));
    const file = path.join(directory, "attachment.txt");
    const writes: string[] = [];
    setMattermostRuntime(createPluginRuntimeMock());
    try {
      await withServer(
        (request, response) => {
          request.resume();
          request.on("end", () => {
            writes.push(request.url ?? "");
            response.writeHead(201, { "content-type": "application/json" });
            response.end(
              JSON.stringify(
                request.url === "/api/v4/files"
                  ? { file_infos: [{ id: "file-cap" }] }
                  : { id: "post-cap", channel_id: "aaaaaaaaaaaaaaaaaaaaaaaaaa" },
              ),
            );
          });
        },
        async (baseUrl) => {
          const opts = {
            cfg: {
              channels: {
                mattermost: {
                  baseUrl,
                  botToken: "fixture",
                  mediaMaxMb: 10,
                  network: { dangerouslyAllowPrivateNetwork: true },
                  accounts: { Limited: { mediaMaxMb: 1 / 1024 } },
                },
              },
            },
            accountId: "limited",
            mediaUrl: file,
            mediaLocalRoots: [directory],
          };
          await writeFile(file, "x".repeat(1536));
          await expect(
            sendMessageMattermost("channel:aaaaaaaaaaaaaaaaaaaaaaaaaa", "caption", opts),
          ).rejects.toThrow(/exceeds.*limit/i);
          expect(writes).toEqual([]);
          await writeFile(file, "x".repeat(512));
          const result = await sendMessageMattermost(
            "channel:aaaaaaaaaaaaaaaaaaaaaaaaaa",
            "caption",
            opts,
          );
          expect(result.messageId).toBe("post-cap");
          expect(writes).toEqual(["/api/v4/files", "/api/v4/posts"]);
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
