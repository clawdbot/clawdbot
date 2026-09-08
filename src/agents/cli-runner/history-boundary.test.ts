import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  getCliHistoryWriter,
  runWithCliHistoryWriter,
} from "../../config/sessions/cli-history-boundary.js";
import {
  appendTranscriptEventSync,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../../config/sessions/session-entry-projection.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { closeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "../sessions/session-manager.js";
import { prepareCliHistoryBoundary } from "./history-boundary.js";
import { buildCliSessionHistoryPrompt, loadCliSessionPromptContext } from "./session-history.js";
import type { PreparedCliRunContext } from "./types.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const databases = new Set<string>();
afterEach(() => {
  for (const database of databases) {
    closeOpenClawAgentDatabaseByPath(database);
  }
  databases.clear();
});

async function fixture(withHeader = true) {
  const dir = dirs.make("cli-history-boundary-");
  const target = {
    agentId: "main",
    sessionId: "history",
    sessionKey: "agent:main:history",
    storePath: path.join(dir, "openclaw-agent.sqlite"),
  };
  databases.add(target.storePath);
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  if (withHeader) {
    appendTranscriptEventSync(target, {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: target.sessionId,
      cwd: dir,
      timestamp: new Date(0).toISOString(),
    });
  }
  const manager = () => SessionManager.open(target, dir);
  let runNumber = 0;
  const run = async <T>(
    epoch: string | undefined,
    action: (allowed: boolean, params: PreparedCliRunContext["params"]) => Promise<T>,
    overrides: Partial<PreparedCliRunContext["params"]> = {},
    credential?: AuthProfileCredential,
  ) => {
    const runId = "boundary-run-" + ++runNumber;
    await patchSessionEntryCore(target, (entry) => ({ ...entry, activeWriterRunId: runId }));
    const admission = prepareSystemAgentRunAdmission({}, runId, "main", "history-test");
    try {
      const params: PreparedCliRunContext["params"] = {
        admittedRunContext: await admission.admit("embedded"),
        runId,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionFile: target.sessionKey,
        sessionTarget: target,
        provider: "test-cli",
        model: "test-model",
        prompt: "current ask",
        workspaceDir: dir,
        timeoutMs: 1000,
        ...overrides,
      };
      const writer = await prepareCliHistoryBoundary(params, {
        credential:
          credential ?? (epoch ? { type: "token", provider: "test-cli", token: epoch } : undefined),
      });
      return await runWithCliHistoryWriter(writer, () => action(Boolean(writer), params));
    } finally {
      admission.close();
    }
  };
  const seed = async () =>
    await run("epoch-a", async (allowed) => {
      expect(allowed).toBe(true);
      manager().appendMessage({ role: "user", content: "A private canary", timestamp: 1 });
    });
  return { target, manager, run, seed };
}

async function history(allowed: boolean, params: PreparedCliRunContext["params"]) {
  return buildCliSessionHistoryPrompt({
    messages: (
      await loadCliSessionPromptContext({
        ...params,
        allowRawTranscriptReseed: true,
        rawTranscriptReseedReason: allowed ? "missing-transcript" : "auth-unknown",
      })
    ).reseedMessages,
    prompt: "current ask",
    maxHistoryChars: 8192,
  });
}

describe("CLI transcript account boundary", () => {
  it("establishes coverage before the first transcript header and user row exist", async () => {
    const f = await fixture(false);
    await f.seed();
    await f.run("epoch-a", async (allowed, params) => {
      expect(await history(allowed, params)).toContain("A private canary");
    });
  });
  it("retains same-account raw and compacted history without exposing private metadata", async () => {
    const f = await fixture();
    await f.seed();
    await f.run("epoch-a", async (allowed, params) => {
      expect(await history(allowed, params)).toContain("A private canary");
      const manager = f.manager();
      const leaf = manager.getLeafId();
      if (!leaf) {
        throw new Error("Missing seeded transcript leaf");
      }
      manager.appendCompaction("A private summary", leaf, 1000);
    });
    await f.run("epoch-a", async (allowed, params) => {
      expect(await history(allowed, params)).toContain("A private summary");
    });
    const entry: InternalSessionEntry | undefined = loadSessionEntryReadOnly(f.target);
    expect(entry?.cliHistoryBoundary?.state).toBe("known");
    if (!entry) {
      throw new Error("Missing session");
    }
    expect(projectPublicSessionEntry(entry)).not.toHaveProperty("cliHistoryBoundary");
  });

  it("distinguishes OAuth account identity from rotating or identity-less tokens", async () => {
    const f = await fixture();
    const credential = {
      type: "oauth" as const,
      provider: "test-cli",
      access: "synthetic-access",
      refresh: "synthetic-refresh",
      expires: Date.now() + 60_000,
    };
    await f.run(undefined, async (allowed) => expect(allowed).toBe(false), {}, credential);
    await f.run(
      undefined,
      async (allowed) => {
        expect(allowed).toBe(true);
        f.manager().appendMessage({ role: "user", content: "named account", timestamp: 1 });
      },
      {},
      { ...credential, accountId: "account-a" },
    );
    await f.run(
      undefined,
      async (allowed, params) => {
        expect(await history(allowed, params)).toContain("named account");
      },
      {},
      { ...credential, accountId: "account-a", access: "rotated-access" },
    );
    await f.run(
      undefined,
      async (allowed) => expect(allowed).toBe(false),
      {},
      { ...credential, accountId: "account-b" },
    );
  });

  it("compares resolved static tokens rather than the unchanged SecretRef", async () => {
    const f = await fixture();
    const tokenRef = { source: "env" as const, provider: "default", id: "TEST_TOKEN" };
    await f.run(
      undefined,
      async (allowed) => {
        expect(allowed).toBe(true);
        f.manager().appendMessage({ role: "user", content: "prior token", timestamp: 1 });
      },
      {},
      { type: "token", provider: "test-cli", token: "resolved-a", tokenRef },
    );
    await f.run(
      undefined,
      async (allowed) => expect(allowed).toBe(false),
      {},
      { type: "token", provider: "test-cli", token: "resolved-b", tokenRef },
    );
  });

  it("revokes retained read and coverage capabilities when their admitted run closes", async () => {
    const f = await fixture();
    const writer = await f.run("epoch-a", async () => getCliHistoryWriter(f.target));
    if (!writer) {
      throw new Error("Missing admitted history writer");
    }
    const before = f.manager().getEntries();
    expect(() => writer.assertReadable()).toThrow();
    expect(() =>
      runWithCliHistoryWriter(writer, () =>
        f.manager().appendMessage({
          role: "user",
          content: "late write",
          timestamp: 1,
        }),
      ),
    ).toThrow();
    expect(f.manager().getEntries()).toEqual(before);
  });

  it("detaches background persistence without lending it the closed CLI history proof", async () => {
    const f = await fixture();
    const release = createDeferred();
    const { background } = await f.run("epoch-a", async () => ({
      background: runWithoutOwnedSessionTranscriptWrites(async () => {
        await release.promise;
        f.manager().appendMessage({ role: "user", content: "detached result", timestamp: 1 });
      }),
    }));
    release.resolve();
    await expect(background).resolves.toBeUndefined();
    expect(JSON.stringify(f.manager().getEntries())).toContain("detached result");
    await f.run("epoch-a", async (allowed) => expect(allowed).toBe(false));
  });

  it("cannot launder mixed history by returning to the original account", async () => {
    const f = await fixture();
    await f.seed();
    await f.run("epoch-b", async (allowed, params) => {
      expect(await history(allowed, params)).toBeUndefined();
      f.manager().appendMessage({ role: "user", content: "B private canary", timestamp: 2 });
    });
    for (const epoch of ["epoch-a", "epoch-b"]) {
      await f.run(epoch, async (allowed, params) => {
        expect(await history(allowed, params)).toBeUndefined();
      });
    }
  });

  it.each(["unrecorded append", "rewrite", "missing provenance", "old version"])(
    "refuses legacy, import, and downgrade gaps: %s",
    async (change) => {
      const f = await fixture();
      await f.seed();
      if (change === "unrecorded append") {
        // Models run by an older binary cannot advance the new coverage proof.
        f.manager().appendMessage({ role: "user", content: "unverified account", timestamp: 2 });
      } else if (change === "rewrite") {
        const manager = f.manager();
        manager.appendResetBoundary("reset", manager.getLeafId() ?? undefined);
      } else if (change === "missing provenance") {
        await patchSessionEntryCore(f.target, (entry) => ({
          ...entry,
          cliHistoryBoundary: undefined,
        }));
      } else {
        // A predecessor wrote serialized metadata outside the current typed writer contract.
        const database = new DatabaseSync(f.target.storePath);
        try {
          expect(
            database
              .prepare(
                "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.cliHistoryBoundary.version', 0) WHERE session_key = ?",
              )
              .run(f.target.sessionKey).changes,
          ).toBe(1);
        } finally {
          database.close();
        }
      }
      await f.run("epoch-a", async (allowed, params) => {
        expect(await history(allowed, params)).toBeUndefined();
      });
    },
  );

  it("never treats an authless runtime or borrowed native session as a new trusted history", async () => {
    const f = await fixture();
    await f.run(undefined, async (allowed) => expect(allowed).toBe(false));
    await f.run("epoch-a", async (allowed) => expect(allowed).toBe(false), {
      cliSessionBinding: { sessionId: "external", forceReuse: true },
    });
  });

  it("only an empty reset can establish a fresh account boundary", async () => {
    const f = await fixture();
    await f.seed();
    await f.run("epoch-b", async (allowed) => expect(allowed).toBe(false));
    f.manager().appendResetBoundary("reset");
    await f.run("epoch-b", async (allowed) => {
      expect(allowed).toBe(true);
      f.manager().appendMessage({ role: "user", content: "B fresh canary", timestamp: 2 });
    });
    await f.run("epoch-b", async (allowed, params) => {
      const prompt = await history(allowed, params);
      expect(prompt).toContain("B fresh canary");
      expect(prompt).not.toContain("A private canary");
    });
  });
});
