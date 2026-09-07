# Agent Runtime Completeness

Use this rubric when assigning category Completeness scores for the
`agent-runtime-and-provider-execution` surface.

## Category Scope

- Agent Turn Execution: Turn startup and runtime choice, Session and run coordination, Abort and terminal outcomes
- External Runtimes and Subagents: External harness selection, CLI runtime aliases, Subagent turns, Runtime recovery
- Hosted Provider Execution: Hosted provider turns, Provider-specific model options, Hosted tool use, Reasoning and cache controls, Hosted streaming and replies
- Local and Self-hosted Providers: Local provider profiles, Tool-capability flags, Timeouts and context windows, Local smoke checks, Local failure handling
- Model and Runtime Selection: Model reference selection, Provider and runtime overrides, Thinking and context settings, Invalid route recovery
- Provider Auth: Login and API-key setup, Auth profile selection, Credential health checks, Auth failover, Provider fallback recovery, Rate-limit and capacity recovery, Missing-key and OAuth guidance, Restart and stale-route recovery, Structured provider diagnostics, Subagent credential propagation
- Streaming and Progress: Streaming replies, Progress visibility
- Tool Calls and Response Handling: Tool-call handling, Usage and response reporting, Failure recovery
- Tool Execution Controls: Tool availability rules, Sandboxed exec behavior, Approval flow, Elevated execution, Tool safety controls, Delegated tool access
