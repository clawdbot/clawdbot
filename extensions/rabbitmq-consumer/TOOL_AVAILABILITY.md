# Tool availability in interactive Suheng conversations

Interactive chat does not pass a message-derived `toolsAllow` list to the agent
runtime. The runtime builds the available catalog from registered tools and applies
the configured provider, agent, owner, group, sandbox and subagent policies on every
run. Removing the extra chat filter does not grant permission or register a missing
tool. Changes to runtime configuration or permissions still take effect.

The catalog must not shrink because a follow-up omits nouns from the original
request. A chart request followed by “make it clearer”, “retry”, or “continue” uses
the same discovery path. This also covers skills, documents, attachments and newly
registered plugin tools without another keyword list or per-session capability
cache. Restarts and transcript snapshots do not need capability-state migration.

Intent-specific instructions and selected skills can guide which tools to use;
they must not decide which authorized tools exist. Availability is not permission
to perform an external action: tool-level confirmation and account checks remain
mandatory. Scheduled or otherwise constrained jobs can retain their explicit
task-specific allowlists; this change only concerns interactive chat.

Tradeoff: ordinary turns can carry more tool schemas. In return, the catalog no
longer changes with wording, improving continuity and tool-prefix cache stability
when the underlying configuration stays unchanged. Future token optimization
should use runtime-supported tool discovery with an always-available way to obtain
needed tools, not silently discard capabilities based on one message.

Regression coverage lives in `src/chat-pipeline.test.ts`: multi-turn artifact
creation, revisions, retries and skill follow-ups must preserve the runtime tool
catalog. Core policy tests separately cover deny rules and account boundaries.
