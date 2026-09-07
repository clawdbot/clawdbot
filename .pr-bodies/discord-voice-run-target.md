## What Problem This Solves

Discord voice `maybeControlDiscordVoiceAgentRun` / `handleAgentControlToolCall`
omitted `runTarget` when calling `controlRealtimeVoiceAgentRun`, so control fell
into the session-key legacy path (`resolveActiveEmbeddedRunSessionId` →
abort/queue by sessionId) without verifying `route.agentId`. A foreign agent
registered on the same sessionKey could be cancelled/steered. Gateway Talk
already passes an owned `runTarget`.

## Why This Change Was Made

Discord-only: always pass an owned `runTarget`, or `runTarget: null` when
ownership cannot be proven (fail-closed). Add a plugin-sdk seam
`resolveOwnedActiveRealtimeVoiceRunTargetForAgent` (sessionKey + agentId) and a
Discord-local resolver that also fences voice session lifecycle. Do not change
`abortEmbeddedAgentRun` (#141379) or Talk gateway ownership (#132129).

## User Impact

**Before:** Saying “cancel” in Discord voice could abort another agent’s run
that collided on the same sessionKey.

**After:** Discord voice control only affects a run proven to match
`route.sessionKey` + `route.agentId` on a live voice session; otherwise it
fail-closes with no active run.

## Evidence

- Changed: `src/talk/realtime-voice-run-target.ts`,
  `src/talk/realtime-voice-run-target.test.ts`,
  `src/plugin-sdk/realtime-voice.ts`,
  `extensions/discord/src/voice/agent-run-target.ts`,
  `extensions/discord/src/voice/agent-control.ts`,
  `extensions/discord/src/voice/agent-control.test.ts`,
  `extensions/discord/src/voice/agent-control.run-target.test.ts`,
  `extensions/discord/src/voice/realtime-consults.ts`,
  plus expectation updates in Discord voice tests
- Production path: Discord voice transcript/tool control →
  `controlDiscordVoiceAgentRun` →
  `resolveDiscordVoiceAgentRunTarget` →
  `resolveOwnedActiveRealtimeVoiceRunTargetForAgent` →
  `controlRealtimeVoiceAgentRun({ runTarget })`
- Compatibility: Talk/`resolveOwnedActiveTalkRunTarget` unchanged; omitting
  `runTarget` elsewhere retains legacy behavior
- Dedup: ≠ #132129 (Talk ownership), ≠ #141379 (embedded abort agent scope)

## Real behavior proof

### Behavior or issue addressed

Foreign agentId `ops` on Discord sessionKey is not aborted; matching `main`
owned run is cancelled; stopped voice session fail-closes; callers always pass
`runTarget` (never `{sessionKey,text}` only).

### Canonical reachability path

Discord voice `maybeControlDiscordVoiceAgentRun` /
`handleAgentControlToolCall` → `controlDiscordVoiceAgentRun` → owned/null
`runTarget` → `controlRealtimeVoiceAgentRun`

### Shared helper / provider constraint check

Owner check lives in the new plugin-sdk seam + Discord lifecycle fence. No
change to `abortEmbeddedAgentRun` signature or Talk `clientConnId` ownership.

### Real environment tested

Local trusted source checkout at PR head; Vitest unit + extension-discord;
real `setActiveEmbeddedRun` registry + production Discord callers.

### Exact steps or command run after this patch

```bash
node scripts/run-vitest.mjs src/talk/realtime-voice-run-target.test.ts extensions/discord/src/voice/agent-control.test.ts extensions/discord/src/voice/agent-control.run-target.test.ts --reporter=verbose
```

### Evidence after fix

```text
[test] starting test/vitest/vitest.unit.config.ts

 RUN  v5.0.0 /workspace/openclaw-nocodet

[vitest-workers] prepared 5736a0429020 in 5686ms (8596 inputs, 4303 outputs)
 ✓ |unit| src/talk/realtime-voice-run-target.test.ts > resolveOwnedActiveRealtimeVoiceRunTargetForAgent > returns null for a foreign agentId on the same sessionKey (fail-closed) 14ms
 ✓ |unit| src/talk/realtime-voice-run-target.test.ts > resolveOwnedActiveRealtimeVoiceRunTargetForAgent > admits the exact owned run for matching sessionKey+agentId 3ms
 ✓ |unit| src/talk/realtime-voice-run-target.test.ts > resolveOwnedActiveRealtimeVoiceRunTargetForAgent > returns null when the voice session lifecycle fence fails 2ms
 ✓ |unit| src/talk/realtime-voice-run-target.test.ts > controlRealtimeVoiceAgentRun with Discord-shaped ownership > null runTarget refuses legacy abort of a foreign-owned run 3ms
 ✓ |unit| src/talk/realtime-voice-run-target.test.ts > controlRealtimeVoiceAgentRun with Discord-shaped ownership > owned runTarget cancels only the matching agent run 13ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  17:41:40
   Duration  9.66s (transform 82%, import 13%, worker 3%, setup 1%)

[test] starting test/vitest/vitest.extension-discord.config.ts

 RUN  v5.0.0 /workspace/openclaw-nocodet

 ✓ |extension-discord| extensions/discord/src/voice/agent-control.test.ts > maybeControlDiscordVoiceAgentRun > falls back for inactive cancel-like phrases 25ms
 ✓ |extension-discord| extensions/discord/src/voice/agent-control.test.ts > maybeControlDiscordVoiceAgentRun > handles active cancel requests with an explicit runTarget 2ms
 ✓ |extension-discord| extensions/discord/src/voice/agent-control.test.ts > maybeControlDiscordVoiceAgentRun > passes an owned runTarget when the Discord resolver admits one 2ms
 ✓ |extension-discord| extensions/discord/src/voice/agent-control.test.ts > maybeControlDiscordVoiceAgentRun > ignores non-control phrases 3ms
 ✓ |extension-discord| extensions/discord/src/voice/agent-control.run-target.test.ts > Discord voice control runTarget ownership (caller path) > fail-closed: foreign agent on the same sessionKey is not aborted 12ms
 ✓ |extension-discord| extensions/discord/src/voice/agent-control.run-target.test.ts > Discord voice control runTarget ownership (caller path) > owned agent cancel aborts the matching embedded run 8ms
 ✓ |extension-discord| extensions/discord/src/voice/agent-control.run-target.test.ts > Discord voice control runTarget ownership (caller path) > stopped voice session refuses ownership (null fail-closed) 2ms

 Test Files  2 passed (2)
      Tests  7 passed (7)
   Start at  17:41:50
   Duration  16.83s (transform 77%, import 16%, worker 6%)

[vitest-workers] verifying completed generation before cleanup
[test] passed 2 Vitest shards in 28.75s
```

### Observed result after fix

Talk ownership tests 5/5 and Discord caller-path tests 7/7 passed; foreign
agent not aborted; owned cancel works; stopped session fail-closes; callers
always include `runTarget`.

### What was not tested

No live Discord VC or Gateway WebSocket session.

## Checklist

- Synced with upstream/main; single commit; conflict-free
- Quota / dedup / owner / fresh-main gates clear
- Template body + Real behavior proof filled; caller-path proof pasted
- AI-assisted; maintainers can edit; no CHANGELOG edit
