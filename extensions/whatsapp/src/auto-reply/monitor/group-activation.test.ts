// Whatsapp tests cover group activation plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getSessionEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGroupActivationFor } from "./group-activation.js";

const GROUP_CONVERSATION_ID = "123@g.us";
const LEGACY_GROUP_SESSION_KEY = "agent:main:whatsapp:group:123@g.us";
const WORK_GROUP_SESSION_KEY = "agent:main:whatsapp:group:123@g.us:thread:whatsapp-account-work";

type SessionStoreEntry = {
  groupActivation?: unknown;
  sessionId?: unknown;
  updatedAt?: unknown;
};

async function makeSessionStore(
  entries: Record<string, unknown> = {},
): Promise<{ storePath: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-"));
  const storePath = path.join(dir, "sessions.json");
  await Promise.all(
    Object.entries(entries as Record<string, SessionEntry>).map(([sessionKey, entry]) =>
      upsertSessionEntry({ storePath, sessionKey, entry }),
    ),
  );
  return {
    storePath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

const resolveWorkGroupActivation = (storePath: string) =>
  resolveGroupActivationFor({
    cfg: {
      channels: {
        whatsapp: {
          accounts: {
            work: {},
          },
        },
      },
      session: { store: storePath },
    } as never,
    accountId: "work",
    agentId: "main",
    sessionKey: WORK_GROUP_SESSION_KEY,
    conversationId: GROUP_CONVERSATION_ID,
  });

const expectWorkGroupActivationEntry = async (
  storePath: string,
  assertEntry?: (entry: SessionStoreEntry | undefined) => void,
) => {
  await vi.waitFor(() => {
    const scopedEntry = getSessionEntry({
      storePath,
      sessionKey: WORK_GROUP_SESSION_KEY,
      readConsistency: "latest",
    });
    expect(scopedEntry?.groupActivation).toBe("always");
    assertEntry?.(scopedEntry);
  });
};

const expectNoWorkGroupActivationEntry = (storePath: string) => {
  expect(
    getSessionEntry({
      storePath,
      sessionKey: WORK_GROUP_SESSION_KEY,
      readConsistency: "latest",
    }),
  ).toBeUndefined();
};

const expectResolvedWorkGroupActivation = async (
  storePath: string,
  assertEntry?: (entry: SessionStoreEntry | undefined) => void,
) => {
  const activation = await resolveWorkGroupActivation(storePath);
  expect(activation).toBe("always");
  await expectWorkGroupActivationEntry(storePath, assertEntry);
};

describe("resolveGroupActivationFor", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("reads legacy named-account group activation without synthesizing a scoped session", async () => {
    const { storePath, cleanup } = await makeSessionStore({
      [LEGACY_GROUP_SESSION_KEY]: {
        groupActivation: "always",
        sessionId: "legacy-session",
        updatedAt: 123,
      },
    });
    cleanups.push(cleanup);

    const activation = await resolveWorkGroupActivation(storePath);
    expect(activation).toBe("always");
    expectNoWorkGroupActivationEntry(storePath);
  });

  it("preserves legacy group activation when the scoped entry already exists without activation", async () => {
    const { storePath, cleanup } = await makeSessionStore({
      [LEGACY_GROUP_SESSION_KEY]: {
        groupActivation: "always",
        sessionId: "legacy-session",
      },
      [WORK_GROUP_SESSION_KEY]: {
        sessionId: "scoped-session",
      },
    });
    cleanups.push(cleanup);

    await expectResolvedWorkGroupActivation(storePath, (scopedEntry) => {
      expect(scopedEntry?.sessionId).toBe("scoped-session");
    });
  });

  it("does not wake the default account from a work-account scoped group activation", async () => {
    const { storePath, cleanup } = await makeSessionStore({
      [WORK_GROUP_SESSION_KEY]: {
        groupActivation: "always",
        sessionId: "work-session",
      },
    });
    cleanups.push(cleanup);

    const cfg = {
      channels: {
        whatsapp: {
          groups: {
            "*": {
              requireMention: true,
            },
          },
          accounts: {
            work: {},
          },
        },
      },
      session: { store: storePath },
    } as never;

    const workActivation = await resolveGroupActivationFor({
      cfg,
      accountId: "work",
      agentId: "main",
      sessionKey: WORK_GROUP_SESSION_KEY,
      conversationId: GROUP_CONVERSATION_ID,
    });

    expect(workActivation).toBe("always");

    const defaultActivation = await resolveGroupActivationFor({
      cfg,
      accountId: "default",
      agentId: "main",
      sessionKey: LEGACY_GROUP_SESSION_KEY,
      conversationId: GROUP_CONVERSATION_ID,
    });

    expect(defaultActivation).toBe("mention");
    await expectWorkGroupActivationEntry(storePath);
  });

  it("does not treat mixed-case default account keys as named accounts", async () => {
    const { storePath, cleanup } = await makeSessionStore({
      [LEGACY_GROUP_SESSION_KEY]: {
        groupActivation: "always",
        sessionId: "legacy-session",
      },
    });
    cleanups.push(cleanup);

    const activation = await resolveGroupActivationFor({
      cfg: {
        channels: {
          whatsapp: {
            groups: {
              "*": {
                requireMention: true,
              },
            },
            accounts: {
              Default: {},
            },
          },
        },
        session: { store: storePath },
      } as never,
      accountId: "default",
      agentId: "main",
      sessionKey: LEGACY_GROUP_SESSION_KEY,
      conversationId: GROUP_CONVERSATION_ID,
    });

    expect(activation).toBe("always");
  });
});
