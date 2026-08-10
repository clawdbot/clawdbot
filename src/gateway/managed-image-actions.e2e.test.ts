import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { readImageProbeFromHeader } from "../media/image-ops.js";
import {
  createManagedOutgoingMediaBlocks,
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
} from "./managed-image-attachments.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import {
  installGatewayTestHooks,
  testState,
  withGatewayServer,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const GATEWAY_TOKEN = "managed-image-actions-e2e-token";
const SESSION_KEY = "agent:main:main";

describe("managed image actions Gateway E2E", () => {
  test("issues one transcript ticket for full and thumbnail image bytes", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for managed image E2E fixtures");
    }
    testState.gatewayAuth = { mode: "token", token: GATEWAY_TOKEN };
    testState.sessionStorePath = path.join(stateDir, "sessions.sqlite");

    const source = await fs.readFile(
      path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"),
    );
    const messageId = "managed-image-actions-message";
    const blocks = await createManagedOutgoingMediaBlocks({
      sessionKey: SESSION_KEY,
      messageId,
      mediaUrls: [`data:image/png;base64,${source.toString("base64")}`],
      stateDir,
    });
    const block = blocks.find(
      (candidate) =>
        candidate.type === "image" &&
        typeof candidate.artifactId === "string" &&
        candidate.artifactId.startsWith(MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX),
    );
    if (!block || typeof block.artifactId !== "string" || typeof block.url !== "string") {
      throw new Error("managed image fixture did not produce an artifact");
    }

    const sessionId = "managed-image-actions-session";
    const transcriptPath = path.join(stateDir, `${sessionId}.jsonl`);
    const timestamp = new Date().toISOString();
    await fs.writeFile(
      transcriptPath,
      [
        { type: "session", version: 3, id: sessionId, timestamp, cwd: stateDir },
        {
          type: "message",
          id: messageId,
          parentId: null,
          timestamp,
          message: {
            role: "assistant",
            content: blocks,
            timestamp: Date.now(),
            __openclaw: { id: messageId },
          },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
      "utf8",
    );
    await writeSessionStore({
      entries: {
        [SESSION_KEY]: {
          sessionId,
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
        },
      },
    });

    await withGatewayServer(
      async ({ port }) => {
        const client = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token: GATEWAY_TOKEN,
          scopes: ["operator.read"],
        });
        try {
          const download = await client.request<{
            artifact?: { id?: string; source?: string };
            url?: string;
            expiresAt?: string;
          }>("artifacts.download", {
            sessionKey: SESSION_KEY,
            artifactId: block.artifactId,
          });
          expect(download.artifact).toMatchObject({
            id: block.artifactId,
            source: "session-transcript",
          });
          expect(download.expiresAt).toEqual(expect.any(String));
          const fullUrl = new URL(download.url ?? "", `http://127.0.0.1:${port}`);
          expect(fullUrl.searchParams.get("mediaTicket")).toMatch(/^v1\./u);

          const full = await fetch(fullUrl);
          expect(full.status).toBe(200);
          const fullBytes = Buffer.from(await full.arrayBuffer());
          expect(fullBytes).toEqual(source);

          const thumbnailUrl = new URL(fullUrl);
          thumbnailUrl.pathname = thumbnailUrl.pathname.replace(/\/full$/u, "/thumbnail");
          const thumbnail = await fetch(thumbnailUrl);
          expect(thumbnail.status).toBe(200);
          expect(thumbnail.headers.get("content-type")).toBe("image/png");
          const thumbnailBytes = Buffer.from(await thumbnail.arrayBuffer());
          expect(readImageProbeFromHeader(thumbnailBytes)).toMatchObject({
            width: 300,
            height: 84,
          });

          const authenticated = await fetch(new URL(String(block.url), fullUrl), {
            headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
          });
          expect(authenticated.status).toBe(200);
          expect(Buffer.from(await authenticated.arrayBuffer())).toEqual(source);
        } finally {
          await disconnectGatewayClient(client);
        }
      },
      { serverOptions: { auth: { mode: "token", token: GATEWAY_TOKEN } } },
    );
  });
});
