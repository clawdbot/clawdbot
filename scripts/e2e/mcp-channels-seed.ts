import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyDockerOpenAiProviderConfig, type OpenClawConfig } from "./docker-openai-seed.ts";

async function main() {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  const configPath =
    process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "openclaw.json");
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  const sessionFile = path.join(sessionsDir, "sess-main.jsonl");
  const storePath = path.join(sessionsDir, "sessions.json");
  const now = Date.now();

  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.mkdir(path.dirname(configPath), { recursive: true });

  const seededConfig = applyDockerOpenAiProviderConfig(
    {
      gateway: {
        controlUi: {
          allowInsecureAuth: true,
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

  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        "agent:main:main": {
          sessionId: "sess-main",
          sessionFile,
          updatedAt: now,
          deliveryContext: {
            channel: "imessage",
            to: "+15551234567",
            accountId: "imessage-default",
            threadId: "thread-42",
          },
          displayName: "Docker MCP Channel Smoke",
          derivedTitle: "Docker MCP Channel Smoke",
          lastMessagePreview: "seeded transcript",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
      JSON.stringify({
        id: "msg-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello from seeded transcript" }],
          timestamp: now,
        },
      }),
      JSON.stringify({
        id: "msg-attachment",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "seeded image attachment" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "abc",
              },
            },
          ],
          timestamp: now + 1,
        },
      }),
    ].join("\n") + "\n",
    "utf-8",
  );

  process.stdout.write(
    JSON.stringify({
      ok: true,
      stateDir,
      configPath,
      storePath,
      sessionFile,
    }) + "\n",
  );
}

await main();
