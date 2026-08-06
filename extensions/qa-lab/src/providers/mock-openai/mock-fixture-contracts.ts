// Canonical inputs and expected plans for mock provider fixture conformance.
const QA_TOOL_PROGRESS_EXEC_COMMAND =
  "rg -n 'matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt' . ; sleep 2";
export const MOCK_FIXTURE_CONFORMANCE_CONTRACTS = {
  heartbeat: {
    prompt:
      "System: Gateway restart config-apply ok\nSystem: QA-SUBAGENT-RECOVERY-1234\n\nRead HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
    reply: "HEARTBEAT_OK",
  },
  toolProgress: {
    read: {
      prompt:
        "Tool progress QA check: read `qa-progress-target.txt` before answering. After the read completes, reply exactly `TOOL_PROGRESS_OK`.",
      path: "qa-progress-target.txt",
    },
    exec: {
      command: QA_TOOL_PROGRESS_EXEC_COMMAND,
      prompt: `Tool progress QA check: call the exec tool exactly once with this exact command before answering: \`${QA_TOOL_PROGRESS_EXEC_COMMAND}\`. After that exec command completes or fails, reply exactly \`TOOL_PROGRESS_EXEC_OK\`.`,
    },
  },
  toolSearch: {
    webSearch: {
      prompt:
        "tool search qa check target=web_search. Call exactly that tool once and then summarize.",
      instructions: "Codex dynamic OpenClaw tools available in this turn: web_search.",
      args: { query: "OpenClaw runtime parity fixed query", count: 1 },
    },
    sessionStatus: {
      prompt:
        "tool search qa check target=session_status. Call exactly that tool once and then summarize.",
      args: { sessionKey: "current" },
    },
    webFetch: {
      prompt:
        "Call web_fetch exactly once with URL https://example.com/ and maxChars 500, wait for its result, then summarize. If web_fetch is already callable, call it directly without tool_search. Otherwise use tool_search to locate it first, then call web_fetch. A tool_search result alone does not complete the task; do not finish before web_fetch returns. QA routing marker: tool search qa check target=web_fetch.",
      args: { url: "https://example.com/", maxChars: 500 },
    },
  },
  explicitSpawn: {
    token: "QA_SUBAGENT_CHILD_FIXED",
    prompt:
      'Use sessions_spawn for this QA check. task="Finish with exactly QA_SUBAGENT_CHILD_FIXED." label=qa-thread-subagent thread=true mode=session',
    args: {
      task: "Finish with exactly QA_SUBAGENT_CHILD_FIXED.",
      label: "qa-thread-subagent",
      thread: true,
      mode: "session",
    },
  },
  subagentHandoff: {
    prompt:
      "Delegate a bounded QA task to a subagent, then summarize the delegated result clearly.",
    responsesLitePrompt:
      "Delegate one bounded QA task to a subagent. Wait for the subagent to finish.",
    args: {
      task: "Inspect the QA workspace and return one concise protocol note.",
      label: "qa-sidecar",
      thread: false,
    },
  },
  genericRead: {
    prompt: "Read repo/qa/scenarios/index.yaml before continuing.",
    path: "repo/qa/scenarios/index.yaml",
  },
  visibleSkill: {
    prompts: [
      "Visible skill marker: give me the visible skill marker exactly.",
      "Use qa-visible-skill now. Reply exactly with the visible skill marker and nothing else.",
    ],
    reply: "VISIBLE-SKILL-OK",
  },
  hotInstall: {
    prompt: "Hot install marker: give me the hot install marker exactly.",
    reply: "HOT-INSTALL-OK",
  },
  unmentionedGroup: {
    prompt:
      'Conversation info: ⟦openclaw:ctx⟧\n{"is_group_chat": true}\n\nhello team, no bot ping here',
    reply: "NO_REPLY",
  },
  directFallbackCompletion: {
    prompt: `[Internal task completion event]\nTask: qa-direct-fallback-worker\nResult: QA-SUBAGENT-DIRECT-FALLBACK-OK`,
    reply: "",
  },
} as const;
