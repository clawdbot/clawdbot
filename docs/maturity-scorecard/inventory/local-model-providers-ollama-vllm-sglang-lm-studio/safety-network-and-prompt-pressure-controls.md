---
title: "Local model providers: Ollama, vLLM, SGLang, LM Studio - Network Safety and Prompt Controls Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Local model providers: Ollama, vLLM, SGLang, LM Studio - Network Safety and Prompt Controls Maturity Note

## Summary

The local-provider surface has strong guardrails around self-hosted network
trust, exact-origin local endpoint access, special-token stripping, and prompts
that reduce pressure on smaller local models. The implementation denies
dangerous metadata-host allowlisting, scopes private-network trust to configured
origins, and documents model-strength limits. Remaining risk comes from the
inherent variability of local model quality and operator-controlled private
network exposure.

## Category Scope

Included in this category:

- Safety Network: Covers Safety Network across private-network and exact-origin trust for local provider base URLs, SSRF protections for self-hosted setup, special-token sanitization, local-model lean prompt behavior, and related safety network and prompt pressure controls behavior.
- Prompt Pressure Controls: Covers Prompt Pressure Controls across private-network and exact-origin trust for local provider base URLs, SSRF protections for self-hosted setup, special-token sanitization, local-model lean prompt behavior, and related safety network and prompt pressure controls behavior.

## Features

- Safety Network: Covers Safety Network across private-network and exact-origin trust for local provider base URLs, SSRF protections for self-hosted setup, special-token sanitization, local-model lean prompt behavior, and related safety network and prompt pressure controls behavior.
- Prompt Pressure Controls: Covers Prompt Pressure Controls across private-network and exact-origin trust for local provider base URLs, SSRF protections for self-hosted setup, special-token sanitization, local-model lean prompt behavior, and related safety network and prompt pressure controls behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals:
  - `/Users/kevinlin/code/openclaw/docs/gateway/security/index.md:632`
    through line 642 document external content special-token sanitization.
  - `/Users/kevinlin/code/openclaw/docs/gateway/security/index.md:691`
    through line 704 document self-hosted LLM backend exposure and trust
    tradeoffs.
  - `/Users/kevinlin/code/openclaw/src/plugins/provider-self-hosted-setup.ts:60`
    through line 76 implement self-hosted SSRF policy.
  - `/Users/kevinlin/code/openclaw/src/agents/provider-transport-fetch.ts:560`
    through line 570 trust exact configured custom or local base URLs.
  - `/Users/kevinlin/code/openclaw/src/agents/local-model-lean.ts:6` through
    line 50 provide local-model prompt pressure controls.
- Negative signals:
  - These controls reduce risk, but local model strength, prompt adherence,
    and private-network exposure are still operator- and model-dependent.
  - User-facing docs explain the risk but do not provide a single readiness
    assessment for "safe enough local provider configuration".
- Integration gaps:
  - Add a local-provider security smoke that attempts metadata-host allowlist,
    private-network exact-origin mismatch, special-token injection, and a
    smaller-model prompt-pressure path.

## Quality Score

- Score: `Stable (82%)`
- Gitcrawl reports:
  - Query `self-hosted local model special tokens allowPrivateNetwork` returned
    PR #73817, relevant to special-token and private-network controls for
    self-hosted local model traffic.
- Discrawl reports:
  - Query `LM Studio local provider` returned maintainer discussion of draft PR
    #80751 for SSRF exact-origin trust and local model calls to LM Studio,
    Ollama, vLLM, and llama-server.
- Good qualities:
  - The exact-origin rule is a strong quality signal: configured local/private
    endpoints can work without broadly trusting arbitrary private-network URLs.
  - Self-hosted setup denies metadata service host allowlisting, and special
    tokens are stripped from external content before model prompts.
  - The code has a specific local-model lean layer instead of relying only on
    generic prompts for smaller local backends.
- Bad qualities:
  - Local model safety remains uneven because the model itself can ignore
    instructions, hallucinate tools, or be deployed behind an unsafe local
    endpoint.
  - Some risk controls are discoverable only after reading security and config
    pages rather than through setup-time warnings.
- Excluded from quality:
  - Test coverage and security test presence were not used as Quality inputs.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/local-model-providers-ollama-vllm-sglang-lm-studio.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Safety Network, Prompt Pressure Controls.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Setup does not appear to produce a consolidated warning that summarizes
  endpoint trust, model strength, prompt pressure, and special-token handling
  for the selected local provider.
- Operator-controlled private network exposure remains a residual risk even
  with exact-origin trust.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/gateway/security/index.md:632`
  documents special-token sanitization for external content.
- `/Users/kevinlin/code/openclaw/docs/gateway/security/index.md:691`
  documents self-hosted LLM backend risks.
- `/Users/kevinlin/code/openclaw/docs/gateway/security/index.md:706`
  documents model-strength expectations.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-tools.md:450` documents
  exact-origin trust.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-tools.md:527` documents
  `allowPrivateNetwork`.
- `/Users/kevinlin/code/openclaw/docs/gateway/local-models.md:324` documents
  local-model troubleshooting and safety guidance.

### Source

- `/Users/kevinlin/code/openclaw/src/plugins/provider-self-hosted-setup.ts:60`
  implements SSRF policy for self-hosted setup.
- `/Users/kevinlin/code/openclaw/src/agents/provider-transport-fetch.ts:560`
  scopes private-network trust to exact configured origins.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-utils.ts:18`
  exports special-token stripping utilities.
- `/Users/kevinlin/code/openclaw/src/agents/local-model-lean.ts:6` implements
  local-model lean prompt behavior.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/plugins/provider-self-hosted-setup.test.ts:373`
  verifies metadata service hosts are not allowed for self-hosted setup.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-utils.strip-model-special-tokens.test.ts:7`
  covers model special-token stripping.
- `/Users/kevinlin/code/openclaw/src/agents/local-model-lean.test.ts:10`
  covers local-model lean behavior.
- `/Users/kevinlin/code/openclaw/src/agents/local-model-lean.test.ts:165`
  covers additional lean prompt behavior.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "self-hosted local model special tokens allowPrivateNetwork" --json --limit 5`

Results:

- Returned PR #73817, relevant to self-hosted local model special-token and
  private-network behavior.

### Discrawl queries

Query: `discrawl search --mode hybrid --limit 5 "LM Studio local provider"`

Results:

- Returned maintainer discussion of draft PR #80751 for SSRF exact-origin trust
  and local model calls to LM Studio, Ollama, vLLM, and llama-server.
