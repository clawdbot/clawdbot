# Anthropic provider path Completeness

Use this rubric when assigning category Completeness scores for the
`anthropic-provider-path` surface.

## Category Scope

- Provider Auth and Recovery: API-key onboarding, Claude CLI credential reuse, Setup-token auth, Auth profile health, Model status, Usage windows, Cooldown/profile reporting, Long-context recovery, Fallback guidance
- Model and Runtime Selection: Bundled Claude catalog, Canonical anthropic refs, Claude CLI compatibility, Model picker availability, Capability metadata, Runtime selection, Session continuity, MCP/tool bridge, Permission-mode mapping, Fallback prelude
- Request Transport and Turn Semantics: API-key/OAuth transport, Messages payloads, Streaming decode, Usage and stop reasons, Abort/error handling, Tool-use blocks, Tool-result replay, Partial JSON recovery, Native thinking, Signed/redacted thinking replay
- Prompt Cache and Context: Cache retention, System-prompt cache boundary, 1M context, Fast mode/service tier, Cache diagnostics
- Media Inputs: Image input, PDF document input, Media model fallback, Image tool results
