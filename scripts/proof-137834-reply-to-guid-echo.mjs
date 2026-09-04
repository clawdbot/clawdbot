// PR #137834: iMessage reply_to_guid echo cache proof.
// Exercises the real production inbound decision path with a real
// createSentMessageCache — no mocks — to prove paired mirror suppression
// and legitimate inline-reply delivery. Also exercises the persisted
// echo cache layer to verify requireMessageIdTextMatch behavior.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createSentMessageCache } from "../extensions/imessage/src/monitor/echo-cache.js";
import { resolveIMessageInboundDecision } from "../extensions/imessage/src/monitor/inbound-processing.js";
import {
  hasPersistedIMessageEcho,
  rememberPersistedIMessageEcho,
} from "../extensions/imessage/src/monitor/persisted-echo-cache.js";
import { setIMessageRuntime } from "../extensions/imessage/src/runtime.js";

const headSha = execSync("git rev-parse --short HEAD").toString().trim();
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proof-"));
setIMessageRuntime({
  state: {
    resolveStateDir: () => stateDir,
    openChannelIngressQueue: () => ({
      enqueue: () => {},
      dequeue: () => undefined,
      close: () => {},
    }),
    openKeyedStore: (options) =>
      createPluginStateSyncKeyedStoreForTests("imessage", {
        ...options,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      }),
    openSyncKeyedStore: (options) =>
      createPluginStateSyncKeyedStoreForTests("imessage", {
        ...options,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      }),
  },
});

const cfg = {};
const scope = "default:imessage:+15555550123";

function makeParams(overrides) {
  const { message: messageOverrides, ...rest } = overrides;
  const message = {
    id: 42,
    sender: "+15555550123",
    text: "ok",
    is_from_me: false,
    is_group: false,
    ...messageOverrides,
  };
  const messageText = rest.messageText ?? message.text ?? "";
  const bodyText = rest.bodyText ?? messageText;
  return {
    cfg,
    accountId: "default",
    opts: undefined,
    allowFrom: ["*"],
    groupAllowFrom: [],
    groupPolicy: "open",
    dmPolicy: "open",
    storeAllowFrom: [],
    historyLimit: 0,
    groupHistories: new Map(),
    echoCache: undefined,
    selfChatCache: undefined,
    isKnownFromMeMessageId: () => false,
    logVerbose: undefined,
    ...rest,
    message,
    messageText,
    bodyText,
  };
}

const results = [];

// Scenario 1: paired mirror with reply_to_guid matching outbound GUID + same text
{
  const echoCache = createSentMessageCache();
  echoCache.remember(scope, { text: "Hello", messageId: "GUID-A" });
  const decision = await resolveIMessageInboundDecision(
    makeParams({
      message: { id: 100, guid: "GUID-B", reply_to_guid: "GUID-A", text: "Hello" },
      messageText: "Hello",
      bodyText: "Hello",
      echoCache,
    }),
  );
  results.push({
    scenario: "paired mirror: reply_to_guid=GUID-A, text=Hello (matches outbound)",
    expected: "drop (echo)",
    actual: decision.kind === "drop" ? "drop (echo)" : decision.kind,
    pass: decision.kind === "drop" && decision.reason === "echo",
  });
}

// Scenario 2: inline reply with reply_to_guid but different text
{
  const echoCache = createSentMessageCache();
  echoCache.remember(scope, { text: "Hello", messageId: "GUID-A" });
  const decision = await resolveIMessageInboundDecision(
    makeParams({
      message: { id: 101, guid: "GUID-C", reply_to_guid: "GUID-A", text: "Goodbye" },
      messageText: "Goodbye",
      bodyText: "Goodbye",
      echoCache,
    }),
  );
  results.push({
    scenario: "inline reply: reply_to_guid=GUID-A, text=Goodbye (differs from outbound)",
    expected: "dispatch",
    actual: decision.kind,
    pass: decision.kind === "dispatch",
  });
}

// Scenario 3: identical text but unrelated reply_to_guid
{
  const echoCache = createSentMessageCache();
  echoCache.remember(scope, { text: "Hello", messageId: "GUID-A" });
  const decision = await resolveIMessageInboundDecision(
    makeParams({
      message: { id: 102, guid: "GUID-D", reply_to_guid: "GUID-UNRELATED", text: "Hello" },
      messageText: "Hello",
      bodyText: "Hello",
      echoCache,
    }),
  );
  results.push({
    scenario: "unrelated reply_to_guid: reply_to_guid=GUID-UNRELATED, text=Hello",
    expected: "dispatch",
    actual: decision.kind,
    pass: decision.kind === "dispatch",
  });
}

// Scenario 4: collision — text matches a different outbound GUID
{
  const echoCache = createSentMessageCache();
  echoCache.remember(scope, { text: "Hello", messageId: "GUID-A" });
  echoCache.remember(scope, { text: "Okay", messageId: "GUID-B" });
  const decision = await resolveIMessageInboundDecision(
    makeParams({
      message: { id: 103, guid: "GUID-C", reply_to_guid: "GUID-A", text: "Okay" },
      messageText: "Okay",
      bodyText: "Okay",
      echoCache,
    }),
  );
  results.push({
    scenario: "collision: reply_to_guid=GUID-A, text=Okay (matches GUID-B's text, not GUID-A's)",
    expected: "dispatch",
    actual: decision.kind,
    pass: decision.kind === "dispatch",
  });
}

// Scenario 5: persisted cache requireMessageIdTextMatch — same text
{
  const pscope = "persisted-test-same";
  rememberPersistedIMessageEcho({ scope: pscope, text: "Hello", messageId: "GUID-A" });
  const hit = hasPersistedIMessageEcho({
    scope: pscope,
    text: "Hello",
    messageId: "GUID-A",
    requireMessageIdTextMatch: true,
  });
  results.push({
    scenario: "persisted cache: same GUID + same text (requireMessageIdTextMatch=true)",
    expected: "true",
    actual: String(hit),
    pass: hit,
  });
}

// Scenario 6: persisted cache requireMessageIdTextMatch — different text
{
  const pscope = "persisted-test-diff";
  rememberPersistedIMessageEcho({ scope: pscope, text: "Hello", messageId: "GUID-A" });
  const hit = hasPersistedIMessageEcho({
    scope: pscope,
    text: "Goodbye",
    messageId: "GUID-A",
    requireMessageIdTextMatch: true,
  });
  results.push({
    scenario: "persisted cache: same GUID + different text (requireMessageIdTextMatch=true)",
    expected: "false",
    actual: String(hit),
    pass: !hit,
  });
}

const allPass = results.every((r) => r.pass);

const verdict = {
  kind: "real-production-path",
  channel: "imessage",
  head: headSha,
  status: allPass ? "pass" : "fail",
  function: "resolveIMessageInboundDecision + hasPersistedIMessageEcho",
  cache: "createSentMessageCache + persisted echo cache (real, no mocks)",
  results,
};

console.log("=== PR #137834: iMessage reply_to_guid echo cache proof ===");
console.log();
console.log(`Verdict: ${verdict.status.toUpperCase()}`);
console.log(`Head: ${verdict.head}`);
console.log(`Function: ${verdict.function}`);
console.log(`Cache: ${verdict.cache}`);
console.log();
for (const r of results) {
  const mark = r.pass ? "✓" : "✗";
  console.log(`${mark} ${r.scenario}`);
  console.log(`  expected: ${r.expected}`);
  console.log(`  actual:   ${r.actual}`);
  console.log();
}
console.log("```json");
console.log(JSON.stringify(verdict, null, 2));
console.log("```");
