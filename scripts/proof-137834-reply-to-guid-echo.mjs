// PR #137834: iMessage reply_to_guid echo cache proof.
// Exercises the real production inbound decision path with a real
// createSentMessageCache — no mocks — to prove paired mirror suppression
// and legitimate inline-reply delivery.
import { createSentMessageCache } from "../extensions/imessage/src/monitor/echo-cache.js";
import { resolveIMessageInboundDecision } from "../extensions/imessage/src/monitor/inbound-processing.js";

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

const allPass = results.every((r) => r.pass);

const verdict = {
  kind: "real-production-path",
  channel: "imessage",
  head: "836018e1fef",
  status: allPass ? "pass" : "fail",
  function: "resolveIMessageInboundDecision",
  cache: "createSentMessageCache (real, no mocks)",
  results,
};

console.log("=== PR #137834: iMessage reply_to_guid echo cache proof ===");
console.log();
console.log(`Verdict: ${verdict.status.toUpperCase()}`);
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
