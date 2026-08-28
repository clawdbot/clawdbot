// Mcp Channels Seed script supports OpenClaw repository automation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessagesByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import { applyDockerOpenAiProviderConfig, type OpenClawConfig } from "./docker-openai-seed.ts";

async function main() {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  const configPath =
    process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "openclaw.json");
  const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  const now = Date.now();

  await fs.mkdir(path.dirname(configPath), { recursive: true });

  const seededConfig = applyDockerOpenAiProviderConfig(
    {
      gateway: {
        controlUi: {
          enabled: false,
        },
      },
      agents: {
        defaults: {
          heartbeat: {
            every: "0m",
          },
        },
      },
      plugins: {
        enabled: false,
      },
    } satisfies OpenClawConfig,
    "sk-docker-smoke-test",
  );

  await fs.writeFile(configPath, JSON.stringify(seededConfig, null, 2), "utf-8");

  await upsertSessionEntry({
    agentId: "main",
    sessionKey: "agent:main:main",
    storePath,
    entry: {
      sessionId: "sess-main",
      updatedAt: now,
      delivery: normalizeSessionDeliveryState({
        context: {
          channel: "imessage",
          to: "+15551234567",
          accountId: "imessage-default",
          threadId: "thread-42",
        },
      }),
      displayName: "Docker MCP Channel Smoke",
    },
  });

  // The installed candidate owns the transcript header and ordered parent links.
  await appendSessionTranscriptMessagesByIdentity({
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "sess-main",
    storePath,
    config: seededConfig,
    messages: [
      {
        eventId: "msg-1",
        now,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello from seeded transcript" }],
          timestamp: now,
        },
      },
      {
        eventId: "msg-attachment",
        now: now + 1,
        message: {
          role: "user",
          content: "seeded image attachment",
          __openclaw: {
            media: [
              {
                url: "media://inbound/seeded-image.png",
                contentType: "image/png",
                kind: "image",
                fileName: "seeded-image.png",
                sizeBytes: 3,
              },
            ],
          },
          timestamp: now + 1,
        },
      },
    ],
  });

  process.stdout.write(`${JSON.stringify({ ok: true, stateDir, configPath, storePath })}\n`);
}

await main();
