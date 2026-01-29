# Agent Role Catalog

Clawdbot utilizes a multi-agent architecture where different components have distinct responsibilities and guardrails.

## Roles

### 1. The Gateway
- **Responsibility**: Management of messaging channels, routing, configuration, and API surface.
- **Scope**: `src/gateway/`
- **Ownership**: Core Infrastructure

### 2. The Runner (Pi Embedded Runner)
- **Responsibility**: Executing the core reasoning loop for an agent session.
- **Scope**: `src/agents/pi-embedded-runner/`
- **Ownership**: Agent Logic

### 3. Subagents
- **Responsibility**: Specialized tasks spawned by the main runner (e.g., browser automation, heavy data processing).
- **Scope**: Managed via `src/agents/subagent-registry.ts`

## Handoff Protocol

When an agent needs to transition work or request assistance:
1. **Tool Invocation**: The primary agent calls a subagent tool.
2. **State Transfer**: The current session context (messages, files) is shared via the `SubagentRegistry`.
3. **Control Return**: Upon completion, the subagent returns a structured result to the primary runner.

## Blocked Behavior

An agent is considered **blocked** if:
- **Authentication Failure**: Multiple auth profiles for a provider are in cooldown or invalid.
- **Context Overflow**: The history exceeds the model's window and cannot be compacted.
- **Safety Violation**: The model refuses to generate a response due to safety filters.

**Action on Blocked**:
- Gateway emits a `chat:error` event.
- The UI displays a distinct "Blocked" state with the reason.
- For interactive sessions, the user is prompted to resolve (e.g., `/new` for context overflow).
