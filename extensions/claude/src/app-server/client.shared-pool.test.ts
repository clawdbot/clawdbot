import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted spawn mock so we can drive fake bridge children without real
// processes. Partial mock — other modules in the import graph use
// execFile/etc., so keep the real exports and override only spawn.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

import type { ClaudeAppServerClient } from "./client.js";
import {
  clearSharedClaudeAppServerClient,
  getSharedClaudeAppServerClient,
  peekSharedClaudeAppServerClient,
} from "./client.js";

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
};

let nextFakePid = 9000;

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = nextFakePid++;
  child.kill = vi.fn();
  child.unref = vi.fn();
  return child;
}

const flush = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/**
 * Real-runtime regression test for openclaw-7ss: the shared client cache
 * must be a keyed pool with an EXPLICIT caller-supplied key (Eddie's
 * 2026-07-02 design call — robust even if extensions/claude and a future
 * extensions/glm-bridge end up sharing a compiled module), not a single
 * slot and not an implicit spawn-options-derived key. Drives the real
 * getSharedClaudeAppServerClient/clearSharedClaudeAppServerClient/
 * peekSharedClaudeAppServerClient — no mocking of the pool logic itself,
 * only the child_process boundary.
 */
describe("shared claude app-server client pool (openclaw-7ss)", () => {
  let children: FakeChild[] = [];

  beforeEach(() => {
    children = [];
    spawnMock.mockImplementation(() => {
      const child = makeFakeChild();
      children.push(child);
      return child;
    });
  });

  afterEach(async () => {
    await clearSharedClaudeAppServerClient();
    spawnMock.mockReset();
  });

  // Calls client.start() (which synchronously calls spawn() and pushes the
  // fake child onto `children`), THEN looks up the just-spawned child, THEN
  // writes its initialize response, THEN awaits start(). Looking the child
  // up only AFTER start() runs (not as a pre-evaluated argument) avoids a
  // JS argument-evaluation-order trap: `children[n]` read before start() is
  // called would still be `undefined`, since spawn() only happens inside
  // start(), not at client construction time.
  async function startAndInitialize(client: ClaudeAppServerClient): Promise<FakeChild> {
    const startP = client.start();
    await flush();
    const child = children[children.length - 1];
    if (!child) {
      throw new Error("expected spawn() to have pushed a fake child by now");
    }
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { version: "0.2.17" } } })}\n`,
    );
    await startP;
    return child;
  }

  const ANTHROPIC_KEY = "claude-bridge:anthropic";
  const ZAI_KEY = "claude-bridge:zai";

  it("returns the same client for the same key and same opts (no re-spawn)", async () => {
    const opts = { command: "fake-bridge", env: { ANTHROPIC_API_KEY: "real-key" } };
    const clientA = getSharedClaudeAppServerClient(ANTHROPIC_KEY, opts);
    await startAndInitialize(clientA);
    await clientA.start(); // already initialized; must resolve immediately

    const clientB = getSharedClaudeAppServerClient(ANTHROPIC_KEY, opts);
    expect(clientB).toBe(clientA);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("spawns a SECOND independent client for a different key WITHOUT stopping the first (the core fix)", async () => {
    const anthropicOpts = { command: "fake-bridge", env: { ANTHROPIC_API_KEY: "real-key" } };
    const zaiOpts = {
      command: "fake-bridge",
      env: {
        ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
        ANTHROPIC_AUTH_TOKEN: "zai-key",
      },
    };

    const anthropicClient = getSharedClaudeAppServerClient(ANTHROPIC_KEY, anthropicOpts);
    const anthropicChild = await startAndInitialize(anthropicClient);

    const zaiClient = getSharedClaudeAppServerClient(ZAI_KEY, zaiOpts);
    await startAndInitialize(zaiClient);

    // Two distinct clients, two distinct spawned children.
    expect(zaiClient).not.toBe(anthropicClient);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // The critical regression check: spawning the second (GLM/Z.ai) client
    // must NOT have torn down the first (Anthropic) child process. Before
    // the fix, getSharedClaudeAppServerClient would call .stop() on the old
    // single-slot client whenever the key changed.
    expect(anthropicChild.stdin.destroyed).toBe(false);
    expect(anthropicClient.isRunning()).toBe(true);
    expect(zaiClient.isRunning()).toBe(true);

    // Re-requesting the anthropic client by its original key/opts still
    // returns the SAME still-running instance — it was never touched.
    const anthropicAgain = getSharedClaudeAppServerClient(ANTHROPIC_KEY, anthropicOpts);
    expect(anthropicAgain).toBe(anthropicClient);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("respawns when the SAME key gets different opts (config-change reconfiguration stays cheap)", async () => {
    const originalOpts = { command: "fake-bridge", env: { ANTHROPIC_API_KEY: "old-key" } };
    const client1 = getSharedClaudeAppServerClient(ANTHROPIC_KEY, originalOpts);
    const child1 = await startAndInitialize(client1);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Same explicit key, but the operator changed the configured env — must
    // tear down the stale process and spawn a fresh one under the same key,
    // exactly like the old single-slot design did on any opts change.
    const changedOpts = { command: "fake-bridge", env: { ANTHROPIC_API_KEY: "new-key" } };
    const client2 = getSharedClaudeAppServerClient(ANTHROPIC_KEY, changedOpts);
    expect(client2).not.toBe(client1);
    expect(child1.stdin.destroyed).toBe(true);
    await startAndInitialize(client2);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // And it's now the one returned for that key going forward.
    const client3 = getSharedClaudeAppServerClient(ANTHROPIC_KEY, changedOpts);
    expect(client3).toBe(client2);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  /**
   * Regression test for openclaw-9jr: a Claude setup-token profile (Tank) and
   * a platform API-key profile (main/narcissus/shiva) both default to the
   * SAME pool key (`claude-bridge:anthropic`, since neither overrides
   * appServer.modelProvider) but resolve to DIFFERENT spawn env, hence
   * different opts fingerprints. Before the fix, a same-key/different-
   * fingerprint request unconditionally called the existing entry's
   * client.stop() — so agent B's turn arriving mid-flight for agent A would
   * kill A's live subprocess and reject A's pending work with "claude-bridge
   * stopped", even though A's turn hadn't failed. Fails before the fix
   * (agent A's client gets stopped), passes after (both clients coexist).
   */
  it("does NOT stop a BUSY client when a different credential's fingerprint requests the same key (openclaw-9jr)", async () => {
    const credA = {
      command: "fake-bridge",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "agent-a-setup-token" },
    };
    const credB = { command: "fake-bridge", env: { ANTHROPIC_API_KEY: "agent-b-platform-key" } };

    const clientA = getSharedClaudeAppServerClient(ANTHROPIC_KEY, credA);
    const childA = await startAndInitialize(clientA);

    // Simulate agent A's in-flight turn: run-attempt.ts registers a
    // notification handler for the whole duration of a turn (see
    // ClaudeAppServerClient.isBusy doc comment).
    const unsubscribeA = clientA.onNotification(() => {});
    expect(clientA.isBusy()).toBe(true);

    // Agent B's turn arrives with a different credential fingerprint under
    // the SAME pool key (same default "anthropic" provider). This must NOT
    // touch agent A's still-busy client.
    const clientB = getSharedClaudeAppServerClient(ANTHROPIC_KEY, credB);

    expect(clientA.isRunning()).toBe(true);
    expect(childA.stdin.destroyed).toBe(false);
    expect(clientA.isBusy()).toBe(true);

    expect(clientB).not.toBe(clientA);
    const childB = await startAndInitialize(clientB);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(childA.stdin.destroyed).toBe(false);

    // Both credentials' clients coexist and are independently retrievable.
    expect(getSharedClaudeAppServerClient(ANTHROPIC_KEY, credA)).toBe(clientA);
    expect(getSharedClaudeAppServerClient(ANTHROPIC_KEY, credB)).toBe(clientB);

    // Once agent A's turn ends (handler unsubscribed), a THIRD credential
    // arriving at the same key may now clean up idle entries — the cheap
    // "reconfiguration" path still works once nothing is actually busy. Both
    // A and B are idle at this point (neither has a notification handler or
    // a pending request), so both get cleaned up; the invariant under test is
    // that a BUSY entry is never touched, not that idle siblings are spared.
    unsubscribeA();
    expect(clientA.isBusy()).toBe(false);
    const credC = { command: "fake-bridge", env: { ANTHROPIC_API_KEY: "agent-c-key" } };
    const clientC = getSharedClaudeAppServerClient(ANTHROPIC_KEY, credC);
    expect(clientC).not.toBe(clientA);
    expect(clientC).not.toBe(clientB);
    expect(childA.stdin.destroyed).toBe(true);
    expect(childB.stdin.destroyed).toBe(true);
  });

  it("peek reflects the most recently accessed pool entry", async () => {
    const anthropicOpts = { command: "fake-bridge", env: { ANTHROPIC_API_KEY: "real-key" } };
    const zaiOpts = { command: "fake-bridge", env: { ANTHROPIC_AUTH_TOKEN: "zai-key" } };

    expect(peekSharedClaudeAppServerClient()).toBeNull();

    const anthropicClient = getSharedClaudeAppServerClient(ANTHROPIC_KEY, anthropicOpts);
    await startAndInitialize(anthropicClient);
    expect(peekSharedClaudeAppServerClient()?.running).toBe(true);

    const zaiClient = getSharedClaudeAppServerClient(ZAI_KEY, zaiOpts);
    await startAndInitialize(zaiClient);
    expect(peekSharedClaudeAppServerClient()?.running).toBe(true);
  });

  it("keyed peek reports a specific entry, not whichever ran most recently (G7)", async () => {
    const anthropicOpts = { command: "fake-bridge", env: { ANTHROPIC_API_KEY: "real-key" } };
    const zaiOpts = { command: "fake-bridge", env: { ANTHROPIC_AUTH_TOKEN: "zai-key" } };

    // A keyed peek before any turn is still null.
    expect(peekSharedClaudeAppServerClient(ANTHROPIC_KEY)).toBeNull();

    const anthropicClient = getSharedClaudeAppServerClient(ANTHROPIC_KEY, anthropicOpts);
    await startAndInitialize(anthropicClient);
    // GLM ran a turn MORE RECENTLY, so the keyless (lastAccessedKey) peek would
    // report the zai entry — the ambiguity G7 is about.
    const zaiClient = getSharedClaudeAppServerClient(ZAI_KEY, zaiOpts);
    await startAndInitialize(zaiClient);

    // The keyed peek still resolves the Claude extension's own slot.
    expect(peekSharedClaudeAppServerClient(ANTHROPIC_KEY)?.running).toBe(true);
    expect(peekSharedClaudeAppServerClient(ZAI_KEY)?.running).toBe(true);

    // Stopping the anthropic slot is visible only through its own key; the
    // keyless peek still points at the most-recently-accessed zai slot.
    await clearSharedClaudeAppServerClient(ANTHROPIC_KEY);
    expect(peekSharedClaudeAppServerClient(ANTHROPIC_KEY)).toBeNull();
    expect(peekSharedClaudeAppServerClient(ZAI_KEY)?.running).toBe(true);

    // An unknown key resolves to null rather than falling back to recency.
    expect(peekSharedClaudeAppServerClient("claude-bridge:nonexistent")).toBeNull();
  });

  it("clearSharedClaudeAppServerClient() with no key stops every pool entry", async () => {
    const anthropicOpts = { command: "fake-bridge", env: { ANTHROPIC_API_KEY: "real-key" } };
    const zaiOpts = { command: "fake-bridge", env: { ANTHROPIC_AUTH_TOKEN: "zai-key" } };

    const anthropicClient = getSharedClaudeAppServerClient(ANTHROPIC_KEY, anthropicOpts);
    const anthropicChild = await startAndInitialize(anthropicClient);

    const zaiClient = getSharedClaudeAppServerClient(ZAI_KEY, zaiOpts);
    const zaiChild = await startAndInitialize(zaiClient);

    await clearSharedClaudeAppServerClient();

    expect(anthropicChild.stdin.destroyed).toBe(true);
    expect(zaiChild.stdin.destroyed).toBe(true);
    expect(peekSharedClaudeAppServerClient()).toBeNull();
  });

  it("clearSharedClaudeAppServerClient(key) stops only that one slot", async () => {
    const anthropicOpts = { command: "fake-bridge", env: { ANTHROPIC_API_KEY: "real-key" } };
    const zaiOpts = { command: "fake-bridge", env: { ANTHROPIC_AUTH_TOKEN: "zai-key" } };

    const anthropicClient = getSharedClaudeAppServerClient(ANTHROPIC_KEY, anthropicOpts);
    const anthropicChild = await startAndInitialize(anthropicClient);

    const zaiClient = getSharedClaudeAppServerClient(ZAI_KEY, zaiOpts);
    const zaiChild = await startAndInitialize(zaiClient);

    await clearSharedClaudeAppServerClient(ANTHROPIC_KEY);

    expect(anthropicChild.stdin.destroyed).toBe(true);
    expect(zaiChild.stdin.destroyed).toBe(false);
    expect(zaiClient.isRunning()).toBe(true);

    // The cleared key gets a fresh client on next request; the untouched
    // key's client is unaffected.
    const anthropicAgain = getSharedClaudeAppServerClient(ANTHROPIC_KEY, anthropicOpts);
    expect(anthropicAgain).not.toBe(anthropicClient);
  });
});
