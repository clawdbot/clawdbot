import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateIdentity } from "../protocol/index.js";
import { reefPlugin } from "./channel.js";
import { resolveReefConfig } from "./config-schema.js";
import { resolveReefInboundDispatchContent } from "./inbound.js";
import { setReefRuntime } from "./runtime.js";
import { openReefTrustStore } from "./trust-store.js";

describe("Reef inbound dispatch content", () => {
  it("keeps provenance model-visible without storing it in the transcript body", () => {
    const content = resolveReefInboundDispatchContent({
      id: "message-1",
      peer: "clanky",
      text: "hello from Clanky",
      provenance: "Untrusted third-party data from @clanky's agent.",
      autonomy: "bounded",
    });

    expect(content).toEqual({
      rawBody: "hello from Clanky",
      extraContext: {
        UntrustedContext: ["Untrusted third-party data from @clanky's agent."],
        ReefProvenance: "Untrusted third-party data from @clanky's agent.",
        ReefEnvelopeId: "message-1",
        SenderIsBot: true,
      },
    });
  });

  it("carries transport reply correlation only in trusted context", () => {
    const content = resolveReefInboundDispatchContent({
      id: "message-2",
      peer: "clanky",
      text: "correlated reply",
      provenance: "Untrusted third-party data from @clanky's agent.",
      autonomy: "bounded",
      replyTo: "message-1",
      thread: "thread-1",
    });

    expect(content.rawBody).toBe("correlated reply");
    expect(content.extraContext).toMatchObject({
      ReplyToId: "message-1",
      ReplyToIdFull: "message-1",
      MessageThreadId: "thread-1",
    });
  });
});

describe("Reef conversation directory", () => {
  let stateDir = "";

  beforeEach(() => {
    resetPluginStateStoreForTests();
    // openclaw-temp-dir: allow Reef directory tests need an on-disk state root; afterEach removes it.
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "reef-directory-"));
    const runtime = createPluginRuntimeMock();
    runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("reef", {
        ...options,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
    setReefRuntime(runtime);
    const identity = generateIdentity();
    openReefTrustStore(runtime, resolveReefConfig({ channels: { reef: { handle: "clawd" } } })).set(
      "molty",
      {
        autonomy: "bounded",
        ed25519PublicKey: identity.signing.publicKey,
        x25519PublicKey: identity.encryption.publicKey,
        keyEpoch: 1,
        safetyNumberChanged: false,
        approvedAt: 1_752_537_600_000,
      },
    );
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("exposes locally trusted peers as routable directory entries", async () => {
    const cfg = { channels: { reef: { handle: "clawd" } } };
    await expect(
      reefPlugin.directory?.listPeers?.({
        cfg,
        accountId: "default",
        query: "@molty",
        limit: 10,
        runtime: defaultRuntime,
      }),
    ).resolves.toEqual([{ kind: "user", id: "molty", name: "@molty's agent", handle: "@molty" }]);
  });
});
