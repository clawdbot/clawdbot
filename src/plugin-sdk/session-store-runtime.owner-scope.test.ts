import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withPluginRuntimePluginIdScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  getSessionEntry,
  patchSessionEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "./session-store-runtime.js";

describe("session-store-runtime plugin owner scope", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-session-owner-scope-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedSessionEntry(sessionKey: string, entry: SessionEntry): Promise<void> {
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry,
    });
  }

  it("rejects plugin-scoped mutations of foreign-owned entries even when the owner is preserved", async () => {
    const sessionKey = "agent:main:foreign-plugin-owned";
    await seedSessionEntry(sessionKey, {
      label: "foreign original",
      pluginOwnerId: "other-plugin",
      sessionId: "foreign-session",
      updatedAt: 10,
    });

    await expect(
      withPluginRuntimePluginIdScope("memory-core", () =>
        patchSessionEntry({
          replaceEntry: true,
          sessionKey,
          storePath,
          update: (entry) => ({
            ...entry,
            label: "foreign mutation",
            pluginOwnerId: "other-plugin",
          }),
        }),
      ),
    ).rejects.toThrow(
      `Plugin "memory-core" cannot mutate session "${sessionKey}" because it is owned by plugin "other-plugin".`,
    );
    expect(getSessionEntry({ sessionKey, storePath })).toMatchObject({
      label: "foreign original",
      pluginOwnerId: "other-plugin",
      sessionId: "foreign-session",
    });
  });

  it("allows plugin-scoped mutations of entries owned by the caller", async () => {
    const sessionKey = "agent:main:caller-plugin-owned";
    await seedSessionEntry(sessionKey, {
      label: "caller original",
      pluginOwnerId: "memory-core",
      sessionId: "caller-session",
      updatedAt: 10,
    });

    await expect(
      withPluginRuntimePluginIdScope("memory-core", () =>
        patchSessionEntry({
          sessionKey,
          storePath,
          update: () => ({ label: "caller mutation", pluginOwnerId: "memory-core" }),
        }),
      ),
    ).resolves.toMatchObject({
      label: "caller mutation",
      pluginOwnerId: "memory-core",
      sessionId: "caller-session",
    });
  });
});
