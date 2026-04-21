import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSessionStore } from "../../auto-reply.test-harness.js";
import { loadSessionStore } from "../config.runtime.js";
import { resolveGroupActivationFor } from "./group-activation.js";

const GROUP_CONVERSATION_ID = "123@g.us";
const LEGACY_GROUP_SESSION_KEY = "agent:main:whatsapp:group:123@g.us";
const WORK_GROUP_SESSION_KEY = "agent:main:whatsapp:group:123@g.us:thread:whatsapp-account-work";

type SessionStoreEntry = {
  groupActivation?: unknown;
  sessionId?: unknown;
  updatedAt?: unknown;
};

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
    const scopedEntry = loadSessionStore(storePath, { skipCache: true })[WORK_GROUP_SESSION_KEY];
    expect(scopedEntry?.groupActivation).toBe("always");
    assertEntry?.(scopedEntry);
  });
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
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("reads legacy named-account group activation and backfills the scoped key", async () => {
    const { storePath, cleanup } = await makeSessionStore({
      [LEGACY_GROUP_SESSION_KEY]: {
        groupActivation: "always",
        sessionId: "legacy-session",
        updatedAt: 123,
      },
    });
    cleanups.push(cleanup);

    await expectResolvedWorkGroupActivation(storePath, (scopedEntry) => {
      expect(scopedEntry?.sessionId).toBeUndefined();
      expect(scopedEntry?.updatedAt).toBeUndefined();
    });
  });

  it("preserves legacy group activation when the scoped entry already exists without activation", async () => {
    const { storePath, cleanup } = await makeSessionStore({
      [LEGACY_GROUP_SESSION_KEY]: {
        groupActivation: "always",
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

  it("does not wake the default account from an activation-only legacy group entry in multi-account setups", async () => {
    const { storePath, cleanup } = await makeSessionStore({
      [LEGACY_GROUP_SESSION_KEY]: {
        groupActivation: "always",
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
