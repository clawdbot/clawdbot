// PR #137834: iMessage monitor boundary proof — loop rate limiter behavior.
// Simulates the monitor-provider's message classification + limiter accounting
// to prove: (1) self-chat mirrors do not trip the limiter, (2) regular echoes
// do trip it after 5 hits, (3) legitimate dispatch succeeds after self-chat
// mirror burst but is suppressed after regular echo burst.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createSentMessageCache } from "../extensions/imessage/src/monitor/echo-cache.js";
import { resolveIMessageInboundDecision } from "../extensions/imessage/src/monitor/inbound-processing.js";
import { createLoopRateLimiter } from "../extensions/imessage/src/monitor/loop-rate-limiter.js";
import { createSelfChatCache } from "../extensions/imessage/src/monitor/self-chat-cache.js";
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
const rateLimitKey = "default:dm:+15555550123";

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

// Simulate monitor-provider.ts:797-804 + 849 limiter logic.
function classifyAndAccount(message, echoCache, selfChatCache, limiter) {
  return resolveIMessageInboundDecision(
    makeParams({ message, echoCache, selfChatCache, ...message }),
  ).then((decision) => {
    if (decision.kind === "drop") {
      // monitor-provider.ts:800-803
      const isLoopDrop =
        decision.reason === "echo" || decision.reason === "reflected assistant content";
      if (isLoopDrop) {
        limiter.record(rateLimitKey);
      }
    }
    // monitor-provider.ts:849
    const suppressed = decision.kind === "dispatch" && limiter.isRateLimited(rateLimitKey);
    return { decision, suppressed, limiterTripped: limiter.isRateLimited(rateLimitKey) };
  });
}

const results = [];

// === Scenario 1: 5 self-chat mirrors (with reply_to_guid) do not trip limiter ===
{
  const echoCache = createSentMessageCache();
  const selfChatCache = createSelfChatCache();
  const limiter = createLoopRateLimiter();

  // Outbound message cached
  echoCache.remember(scope, { text: "Hello", messageId: "GUID-A" });

  // Authored self-chat row populates selfChatCache
  const createdAt = new Date().toISOString();
  await resolveIMessageInboundDecision(
    makeParams({
      message: {
        id: 1,
        guid: "GUID-A",
        text: "Hello",
        is_from_me: true,
        sender: "+15555550123",
        chat_identifier: "+15555550123",
        destination_caller_id: "+15555550123",
        created_at: createdAt,
      },
      messageText: "Hello",
      bodyText: "Hello",
      echoCache,
      selfChatCache,
    }),
  );

  // 5 paired mirrors with reply_to_guid
  for (let i = 0; i < 5; i++) {
    const result = await classifyAndAccount(
      {
        id: 100 + i,
        guid: `GUID-M${i}`,
        reply_to_guid: "GUID-A",
        text: "Hello",
        sender: "+15555550123",
        chat_identifier: "+15555550123",
        destination_caller_id: "+15555550123",
        created_at: createdAt,
        is_from_me: false,
        is_group: false,
      },
      echoCache,
      selfChatCache,
      limiter,
    );
    results.push({
      scenario: `self-chat mirror #${i + 1}: reason=${result.decision.reason}, limiterTripped=${result.limiterTripped}`,
      expected: "drop (self-chat echo), limiter not tripped",
      actual: `reason=${result.decision.reason}, limiterTripped=${result.limiterTripped}`,
      pass:
        result.decision.kind === "drop" &&
        result.decision.reason === "self-chat echo" &&
        !result.limiterTripped,
    });
  }

  // 6th message: legitimate dispatch should NOT be suppressed
  const legit = await classifyAndAccount(
    {
      id: 200,
      guid: "GUID-LEGIT",
      text: "What is the weather?",
      sender: "+15555550123",
      is_from_me: false,
      is_group: false,
    },
    echoCache,
    selfChatCache,
    limiter,
  );
  results.push({
    scenario: "legitimate dispatch after 5 self-chat mirrors",
    expected: "dispatch, not suppressed",
    actual: `kind=${legit.decision.kind}, suppressed=${legit.suppressed}`,
    pass: legit.decision.kind === "dispatch" && !legit.suppressed,
  });
}

// === Scenario 2: 5 regular echoes trip limiter, 6th dispatch suppressed ===
{
  const echoCache = createSentMessageCache();
  const limiter = createLoopRateLimiter();

  // 5 regular echoes (non-self-chat, matching messageId)
  for (let i = 0; i < 5; i++) {
    echoCache.remember(scope, { text: `Echo${i}`, messageId: `GUID-E${i}` });
    const result = await classifyAndAccount(
      {
        id: 300 + i,
        guid: `GUID-E${i}`,
        text: `Echo${i}`,
        sender: "+15555550123",
        is_from_me: false,
        is_group: false,
      },
      echoCache,
      undefined,
      limiter,
    );
    results.push({
      scenario: `regular echo #${i + 1}: reason=${result.decision.reason}`,
      expected: "drop (echo), counted toward limiter",
      actual: `reason=${result.decision.reason}, limiterTripped=${result.limiterTripped}`,
      pass: result.decision.kind === "drop" && result.decision.reason === "echo",
    });
  }

  // 6th message: legitimate dispatch SHOULD be suppressed
  const legit = await classifyAndAccount(
    {
      id: 400,
      guid: "GUID-LEGIT2",
      text: "Hello there",
      sender: "+15555550123",
      is_from_me: false,
      is_group: false,
    },
    echoCache,
    undefined,
    limiter,
  );
  results.push({
    scenario: "legitimate dispatch after 5 regular echoes",
    expected: "dispatch but suppressed (limiter tripped)",
    actual: `kind=${legit.decision.kind}, suppressed=${legit.suppressed}, limiterTripped=${legit.limiterTripped}`,
    pass: legit.limiterTripped && legit.suppressed,
  });
}

// === Scenario 3: self-chat mirrors WITHOUT destination_caller_id ===
{
  const echoCache = createSentMessageCache();
  const selfChatCache = createSelfChatCache();
  const limiter = createLoopRateLimiter();

  echoCache.remember(scope, { text: "Hi", messageId: "GUID-X" });

  // Authored row with destination_caller_id to populate selfChatCache
  const createdAt = new Date().toISOString();
  await resolveIMessageInboundDecision(
    makeParams({
      message: {
        id: 1,
        guid: "GUID-X",
        text: "Hi",
        is_from_me: true,
        sender: "+15555550123",
        chat_identifier: "+15555550123",
        destination_caller_id: "+15555550123",
        created_at: createdAt,
      },
      messageText: "Hi",
      bodyText: "Hi",
      echoCache,
      selfChatCache,
    }),
  );

  // 5 mirrors WITHOUT destination_caller_id, with reply_to_guid
  for (let i = 0; i < 5; i++) {
    const result = await classifyAndAccount(
      {
        id: 500 + i,
        guid: `GUID-N${i}`,
        reply_to_guid: "GUID-X",
        text: "Hi",
        sender: "+15555550123",
        chat_identifier: "+15555550123",
        created_at: createdAt,
        is_from_me: false,
        is_group: false,
      },
      echoCache,
      selfChatCache,
      limiter,
    );
    results.push({
      scenario: `mirror without destination_caller_id #${i + 1}: reason=${result.decision.reason}`,
      expected: "drop (self-chat echo), limiter not tripped",
      actual: `reason=${result.decision.reason}, limiterTripped=${result.limiterTripped}`,
      pass:
        result.decision.kind === "drop" &&
        result.decision.reason === "self-chat echo" &&
        !result.limiterTripped,
    });
  }

  // 6th message: legitimate dispatch should NOT be suppressed
  const legit = await classifyAndAccount(
    {
      id: 600,
      guid: "GUID-LEGIT3",
      text: "How are you?",
      sender: "+15555550123",
      is_from_me: false,
      is_group: false,
    },
    echoCache,
    selfChatCache,
    limiter,
  );
  results.push({
    scenario: "legitimate dispatch after 5 mirrors without destination_caller_id",
    expected: "dispatch, not suppressed",
    actual: `kind=${legit.decision.kind}, suppressed=${legit.suppressed}`,
    pass: legit.decision.kind === "dispatch" && !legit.suppressed,
  });
}

const allPass = results.every((r) => r.pass);

const verdict = {
  kind: "monitor-boundary-limiter-proof",
  channel: "imessage",
  head: headSha,
  status: allPass ? "pass" : "fail",
  function:
    "resolveIMessageInboundDecision + createLoopRateLimiter (monitor-provider.ts limiter contract)",
  results,
};

console.log("=== PR #137834: iMessage monitor boundary limiter proof ===");
console.log();
console.log(`Verdict: ${verdict.status.toUpperCase()}`);
console.log(`Head: ${verdict.head}`);
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
