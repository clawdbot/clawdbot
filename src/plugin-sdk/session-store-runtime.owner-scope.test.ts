import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withPluginRuntimePluginIdScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  getSessionEntry,
  patchSessionEntry,
  updateSessionStore,
  updateSessionStoreEntry,
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

  it("allows plugin-scoped mutations of existing unowned entries when ownership is omitted", async () => {
    const sessionKey = "agent:main:unowned-preserved";
    await seedSessionEntry(sessionKey, {
      label: "unowned original",
      sessionId: "unowned-session",
      updatedAt: 10,
    });

    await expect(
      withPluginRuntimePluginIdScope("memory-core", () =>
        patchSessionEntry({
          sessionKey,
          storePath,
          update: () => ({ label: "unowned mutation" }),
        }),
      ),
    ).resolves.toMatchObject({
      label: "unowned mutation",
      sessionId: "unowned-session",
    });
    expect(getSessionEntry({ sessionKey, storePath })?.pluginOwnerId).toBeUndefined();
  });

  it("rejects plugin-scoped patch claims on existing unowned entries", async () => {
    const sessionKey = "agent:main:unowned-patch-claim";
    await seedSessionEntry(sessionKey, {
      label: "unowned original",
      sessionId: "unowned-session",
      updatedAt: 10,
    });

    await expect(
      withPluginRuntimePluginIdScope("memory-core", () =>
        patchSessionEntry({
          sessionKey,
          storePath,
          update: () => ({ label: "claimed", pluginOwnerId: "memory-core" }),
        }),
      ),
    ).rejects.toThrow(
      `Plugin "memory-core" cannot assign plugin owner "memory-core" to existing unowned session "${sessionKey}".`,
    );
    expect(getSessionEntry({ sessionKey, storePath })).toMatchObject({
      label: "unowned original",
      sessionId: "unowned-session",
    });
    expect(getSessionEntry({ sessionKey, storePath })?.pluginOwnerId).toBeUndefined();
  });

  it("rejects plugin-scoped update and upsert claims on existing unowned entries", async () => {
    const updateSessionKey = "agent:main:main";
    const upsertSessionKey = "agent:main:unowned-upsert-claim";
    for (const sessionKey of [updateSessionKey, upsertSessionKey]) {
      await seedSessionEntry(sessionKey, {
        label: "unowned original",
        sessionId: `${sessionKey}-session`,
        updatedAt: 10,
      });
    }

    await expect(
      withPluginRuntimePluginIdScope("memory-core", () =>
        updateSessionStoreEntry({
          sessionKey: updateSessionKey,
          storePath,
          update: () => ({ label: "claimed", pluginOwnerId: "memory-core" }),
        }),
      ),
    ).rejects.toThrow("cannot assign plugin owner");
    await expect(
      withPluginRuntimePluginIdScope("memory-core", () =>
        upsertSessionEntry({
          agentId: "main",
          sessionKey: upsertSessionKey,
          storePath,
          entry: {
            label: "claimed",
            pluginOwnerId: "memory-core",
            sessionId: "replacement-session",
            updatedAt: 20,
          },
        }),
      ),
    ).rejects.toThrow("cannot assign plugin owner");

    expect(getSessionEntry({ sessionKey: updateSessionKey, storePath })).toMatchObject({
      label: "unowned original",
      sessionId: `${updateSessionKey}-session`,
    });
    expect(getSessionEntry({ sessionKey: upsertSessionKey, storePath })).toMatchObject({
      label: "unowned original",
      sessionId: `${upsertSessionKey}-session`,
    });
  });

  it("rejects deprecated whole-store owner claims on existing unowned entries", async () => {
    const sessionKey = "agent:main:main";
    await seedSessionEntry(sessionKey, {
      label: "unowned original",
      sessionId: "unowned-session",
      updatedAt: 10,
    });

    await expect(
      withPluginRuntimePluginIdScope("memory-core", () =>
        updateSessionStore(storePath, (store) => {
          const projectedSessionKey = Object.keys(store)[0];
          if (!projectedSessionKey) {
            throw new Error("expected seeded session entry");
          }
          const projectedEntry = store[projectedSessionKey];
          if (!projectedEntry) {
            throw new Error("expected projected session entry");
          }
          store[projectedSessionKey] = {
            ...projectedEntry,
            label: "claimed",
            pluginOwnerId: "memory-core",
          };
        }),
      ),
    ).rejects.toThrow("cannot assign plugin owner");
    expect(getSessionEntry({ sessionKey, storePath })).toMatchObject({
      label: "unowned original",
      sessionId: "unowned-session",
    });
    expect(getSessionEntry({ sessionKey, storePath })?.pluginOwnerId).toBeUndefined();
  });
});
