import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  SessionsCatalogListResult,
  SessionsCatalogReadResult,
} from "../../packages/gateway-protocol/src/index.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { connectTestGatewayClient } from "./gateway-cli-backend.live-helpers.js";

async function writeNativeCodexRollout(codexHome: string) {
  const threadId = randomUUID();
  const title = `Native catalog ${randomUUID()}`;
  const timestamp = "2026-09-07T12:00:00.000Z";
  const directory = path.join(codexHome, "sessions", "2026", "09", "07");
  const rollout = path.join(directory, `rollout-2026-09-07T12-00-00-${threadId}.jsonl`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    rollout,
    [
      {
        timestamp,
        type: "session_meta",
        payload: {
          session_id: threadId,
          id: threadId,
          timestamp,
          cwd: path.dirname(codexHome),
          originator: "codex_cli_rs",
          cli_version: "test",
          source: "cli",
          model_provider: "openai",
        },
      },
      {
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: title }],
        },
      },
      {
        timestamp,
        type: "event_msg",
        payload: { type: "user_message", message: title, kind: "plain" },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  return { threadId, title };
}

describe("Gateway Codex native catalog", () => {
  it("lets admins list, exact-title search, and read an isolated process-HOME thread", async () => {
    const token = `catalog-${randomUUID()}`;
    const instance = await createOpenClawTestInstance({
      name: "codex-native-catalog",
      gatewayToken: token,
      state: { layout: "split" },
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_PROVIDERS: undefined,
      },
      config: {
        gateway: { mode: "local" },
        plugins: {
          allow: ["codex"],
          entries: {
            codex: { enabled: true, config: { appServer: { homeScope: "user" } } },
          },
        },
      },
    });
    let admin: Awaited<ReturnType<typeof connectTestGatewayClient>> | undefined;
    let reader: Awaited<ReturnType<typeof connectTestGatewayClient>> | undefined;
    try {
      const native = await writeNativeCodexRollout(path.join(instance.homeDir, ".codex"));
      await instance.startGateway();
      admin = await connectTestGatewayClient({
        url: instance.url,
        token,
        scopes: ["operator.admin", "operator.read"],
      });
      const listed = await admin.request<SessionsCatalogListResult>("sessions.catalog.list", {
        catalogId: "codex",
        agentId: "main",
      });
      const nativeHost = listed.catalogs[0]?.hosts.find((host) =>
        host.sessions.some((session) => session.threadId === native.threadId),
      );
      expect(nativeHost).toBeDefined();

      const searched = await admin.request<SessionsCatalogListResult>("sessions.catalog.list", {
        catalogId: "codex",
        agentId: "main",
        search: native.title,
      });
      expect(
        searched.catalogs.flatMap((catalog) =>
          catalog.hosts.flatMap((host) => host.sessions.map((session) => session.threadId)),
        ),
      ).toContain(native.threadId);

      const transcript = await admin.request<SessionsCatalogReadResult>("sessions.catalog.read", {
        catalogId: "codex",
        agentId: "main",
        hostId: nativeHost!.hostId,
        threadId: native.threadId,
        sourceHomeId: nativeHost!.sessions.find((session) => session.threadId === native.threadId)
          ?.sourceHomeId,
      });
      expect(transcript.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ text: native.title })]),
      );

      reader = await connectTestGatewayClient({
        url: instance.url,
        token,
        scopes: ["operator.read"],
      });
      const readerList = await reader.request<SessionsCatalogListResult>("sessions.catalog.list", {
        catalogId: "codex",
        agentId: "main",
      });
      expect(
        readerList.catalogs.flatMap((catalog) =>
          catalog.hosts.flatMap((host) => host.sessions.map((session) => session.threadId)),
        ),
      ).not.toContain(native.threadId);
      await expect(
        reader.request("sessions.catalog.read", {
          catalogId: "codex",
          agentId: "main",
          hostId: nativeHost!.hostId,
          threadId: native.threadId,
        }),
      ).rejects.toThrow("local Codex sessions are unavailable in isolated state");
    } finally {
      await reader?.stopAndWait().catch(() => undefined);
      await admin?.stopAndWait().catch(() => undefined);
      await instance.cleanup();
    }
  }, 120_000);
});
