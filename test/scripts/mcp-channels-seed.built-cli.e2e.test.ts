import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runSessionStartupMigration } from "../../src/config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  getSessionEntry,
  projectSessionDeliveryFields,
} from "../../src/plugin-sdk/session-store-runtime.js";
import {
  readSessionTranscriptEvents,
  readVisibleSessionTranscriptMessageEntries,
} from "../../src/plugin-sdk/session-transcript-runtime.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

const execFileAsync = promisify(execFile);

describe("MCP channels Docker seed", () => {
  it("seeds startup-ready SQLite history with the MCP conversation and attachment identity", async () => {
    await withOpenClawTestState(
      { label: "mcp-channels-seed", scenario: "empty" },
      async (state) => {
        // Disable checkout aliases so the seed uses built public SDK entrypoints,
        // just as the installed candidate does in the functional Docker image.
        const tsconfigPath = state.path("tsconfig.json");
        await fs.writeFile(tsconfigPath, "{}");
        await execFileAsync(
          process.execPath,
          ["--import", "tsx", "scripts/e2e/mcp-channels-seed.ts"],
          {
            cwd: process.cwd(),
            env: {
              PATH: process.env.PATH,
              ...state.envVars,
              TSX_TSCONFIG_PATH: tsconfigPath,
              TSX_DISABLE_CACHE: "1",
            },
            timeout: 30_000,
          },
        );

        const cfg = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
        await runSessionStartupMigration({ cfg, env: state.env, log: { info() {}, warn() {} } });
        const storePath = path.join(state.agentDir(), "openclaw-agent.sqlite");
        await expect(fs.stat(storePath)).resolves.toMatchObject({ size: expect.any(Number) });
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "sess-main",
          storePath,
          env: state.env,
        };
        const entry = getSessionEntry(scope);
        expect(entry).toMatchObject({
          sessionId: "sess-main",
          displayName: "Docker MCP Channel Smoke",
        });
        expect(projectSessionDeliveryFields(entry?.delivery)).toMatchObject({
          deliveryContext: {
            channel: "imessage",
            to: "+15551234567",
            accountId: "imessage-default",
            threadId: "thread-42",
          },
        });
        expect(entry).not.toHaveProperty("sessionFile");
        await expect(readSessionTranscriptEvents(scope)).resolves.toMatchObject([
          { type: "session", id: "sess-main" },
          { type: "message", id: "msg-1", parentId: null },
          { type: "message", id: "msg-attachment", parentId: "msg-1" },
        ]);
        await expect(readVisibleSessionTranscriptMessageEntries(scope)).resolves.toMatchObject([
          {
            entryId: "msg-1",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hello from seeded transcript" }],
            },
          },
          {
            entryId: "msg-attachment",
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
            },
          },
        ]);
        for (const name of ["sessions.json", "sess-main.jsonl"]) {
          await expect(fs.stat(path.join(state.sessionsDir(), name))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      },
    );
  });

  it("keeps the pre-SQLite session seed only for an authorized frozen target", async () => {
    await withOpenClawTestState(
      { label: "mcp-channels-seed-frozen", scenario: "empty" },
      async (state) => {
        const tsconfigPath = state.path("tsconfig.json");
        await fs.writeFile(tsconfigPath, "{}");
        await execFileAsync(
          process.execPath,
          ["--import", "tsx", "scripts/e2e/mcp-channels-seed.ts"],
          {
            cwd: process.cwd(),
            env: {
              PATH: process.env.PATH,
              ...state.envVars,
              OPENCLAW_FROZEN_PLUGIN_PRERELEASE_FIXTURE_DIALECT: "legacy",
              TSX_TSCONFIG_PATH: tsconfigPath,
              TSX_DISABLE_CACHE: "1",
            },
            timeout: 30_000,
          },
        );

        const config = JSON.parse(await fs.readFile(state.configPath, "utf8"));
        expect(config.gateway.controlUi).toMatchObject({ allowInsecureAuth: true, enabled: false });
        const sessionsPath = path.join(state.sessionsDir(), "sessions.json");
        await expect(fs.readFile(sessionsPath, "utf8")).resolves.toContain(
          '"sessionId":"sess-main"',
        );
        await expect(
          fs.readFile(path.join(state.sessionsDir(), "sess-main.jsonl"), "utf8"),
        ).resolves.toContain('"id":"msg-attachment"');
        await expect(
          fs.stat(path.join(state.agentDir(), "openclaw-agent.sqlite")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
    );
  });
});
