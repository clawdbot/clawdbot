import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSessionStore } from "../../auto-reply.test-harness.js";
import { loadSessionStore } from "../config.runtime.js";
import { resolveGroupActivationFor } from "./group-activation.js";

describe("resolveGroupActivationFor", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("reads legacy named-account group activation and backfills the scoped key", async () => {
    const sessionKey = "agent:main:whatsapp:group:123@g.us:thread:whatsapp-account-work";
    const legacySessionKey = "agent:main:whatsapp:group:123@g.us";
    const { storePath, cleanup } = await makeSessionStore({
      [legacySessionKey]: {
        groupActivation: "always",
        sessionId: "legacy-session",
        updatedAt: 123,
      },
    });
    cleanups.push(cleanup);

    const activation = await resolveGroupActivationFor({
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
      sessionKey,
      conversationId: "123@g.us",
    });

    expect(activation).toBe("always");
    await vi.waitFor(() => {
      const scopedEntry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
      expect(scopedEntry?.groupActivation).toBe("always");
      expect(scopedEntry?.sessionId).toBeUndefined();
      expect(scopedEntry?.updatedAt).toBeUndefined();
    });
  });

  it("preserves legacy group activation when the scoped entry already exists without activation", async () => {
    const sessionKey = "agent:main:whatsapp:group:123@g.us:thread:whatsapp-account-work";
    const legacySessionKey = "agent:main:whatsapp:group:123@g.us";
    const { storePath, cleanup } = await makeSessionStore({
      [legacySessionKey]: {
        groupActivation: "always",
      },
      [sessionKey]: {
        sessionId: "scoped-session",
      },
    });
    cleanups.push(cleanup);

    const activation = await resolveGroupActivationFor({
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
      sessionKey,
      conversationId: "123@g.us",
    });

    expect(activation).toBe("always");
    await vi.waitFor(() => {
      const scopedEntry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
      expect(scopedEntry?.groupActivation).toBe("always");
      expect(scopedEntry?.sessionId).toBe("scoped-session");
    });
  });

  it("does not wake the default account from an activation-only legacy group entry in multi-account setups", async () => {
    const defaultSessionKey = "agent:main:whatsapp:group:123@g.us";
    const workSessionKey = "agent:main:whatsapp:group:123@g.us:thread:whatsapp-account-work";
    const { storePath, cleanup } = await makeSessionStore({
      [defaultSessionKey]: {
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
      sessionKey: workSessionKey,
      conversationId: "123@g.us",
    });

    expect(workActivation).toBe("always");

    const defaultActivation = await resolveGroupActivationFor({
      cfg,
      accountId: "default",
      agentId: "main",
      sessionKey: defaultSessionKey,
      conversationId: "123@g.us",
    });

    expect(defaultActivation).toBe("mention");
    await vi.waitFor(() => {
      const scopedEntry = loadSessionStore(storePath, { skipCache: true })[workSessionKey];
      expect(scopedEntry?.groupActivation).toBe("always");
    });
  });

  it("does not treat mixed-case default account keys as named accounts", async () => {
    const defaultSessionKey = "agent:main:whatsapp:group:123@g.us";
    const { storePath, cleanup } = await makeSessionStore({
      [defaultSessionKey]: {
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
      sessionKey: defaultSessionKey,
      conversationId: "123@g.us",
    });

    expect(activation).toBe("always");
  });
});
