---
title: "Web search tools Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Web search tools Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (79%)`
- Quality: `Beta (76%)`
- Completeness: `Beta (79%)`
- LTS Features: `0/4`

## Summary

This report promotes the archived `web-search-tools` maturity evidence from `/Users/kevinlin/tmp/maturity/web-search-tools` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                            | LTS | Coverage       | Quality        | Completeness   | Features to evaluate                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | --- | -------------- | -------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Search Providers](bundled-structured-search-providers.md)                          | ❌  | `Beta (76%)`   | `Beta (72%)`   | `Beta (76%)`   | API-backed providers, Keyless and self-hosted providers, Provider comparison and auto-detection, Provider-specific filters and extraction, Result normalization, OpenAI native web_search, Codex native web_search, Gemini grounding, Grok web grounding, Kimi web search, Provider-native citations, Model and filter routing, webSearchProviders, registerWebSearchProvider, webFetchProviders, registerWebFetchProvider, public-artifact loading, runtime resolution, contract tests |
| [Setup and Diagnostics](operator-setup-provider-selection-and-credential-repair.md) | ❌  | `Beta (74%)`   | `Beta (70%)`   | `Beta (74%)`   | Provider credentials, Default provider selection, Credential repair, Status checks, Quota errors, Cache controls, Provider diagnostics, Retry and fallback, Operator repair                                                                                                                                                                                                                                                                                                             |
| [Network Safety](network-safety-ssrf-redirects-and-untrusted-content.md)            | ❌  | `Stable (84%)` | `Stable (84%)` | `Stable (84%)` | Network Safety, SSRF, Redirects, Untrusted Content                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [Tool Availability and Fetch](tool-exposure-policy-and-runtime-tool-wiring.md)      | ❌  | `Stable (82%)` | `Stable (80%)` | `Stable (82%)` | web_search exposure, web_fetch exposure, x_search exposure, group:web policy, disabled-state diagnostics, provider/model gating, URL fetch, HTML extraction, PDF/text extraction, Safe truncation, Content citation handoff                                                                                                                                                                                                                                                             |

## Scoring rubric

- Coverage:
  maturity-label rating for integration, e2e, live, or server/runtime flow
  evidence across the category. Unit tests can provide supporting context but never make a
  feature covered by themselves.
- Quality:
  maturity-label rating for implementation and operational robustness. Unit,
  integration, e2e, live, and real runtime-flow test coverage are Coverage
  inputs only; they do not raise or lower Quality.
- Completeness:
  maturity-label rating for how fully the category delivers the intended
  surface-specific capability set. Use the taxonomy-linked completeness
  instructions for this surface.
- LTS:
  calculated as `quality > 80 and coverage > 90`, or when the matching
  taxonomy category sets `human_lts_override`.
- Shared score bands:
  `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`,
  `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the
  higher maturity label.
- Major quality/completeness gaps:
  evidence text only, tracked in the detailed feature inventory rather than as a
  separate scored dimension.

## Detailed feature inventory

### 1. Search Providers

Search anchors: API-backed providers, Keyless and self-hosted providers, Provider comparison and auto-detection, Provider-specific filters and extraction, Result normalization, OpenAI native web_search, Codex native web_search, Gemini grounding, Grok web grounding, Kimi web search, Provider-native citations, Model and filter routing, webSearchProviders, registerWebSearchProvider, webFetchProviders, registerWebFetchProvider, public-artifact loading, runtime resolution, contract tests.

Category note: [Search Providers](bundled-structured-search-providers.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- API-backed providers: Covers API-backed providers provider routing, request shaping, streaming, and response normalization for Structured Search Providers.
- Keyless and self-hosted providers: Covers Keyless and self-hosted providers provider routing, request shaping, streaming, and response normalization for Structured Search Providers.
- Provider comparison and auto-detection: Covers Provider comparison and auto-detection provider routing, request shaping, streaming, and response normalization for Structured Search Providers.
- Provider-specific filters and extraction: Covers Provider-specific filters and extraction provider routing, request shaping, streaming, and response normalization for Structured Search Providers.
- Result normalization: Covers Result normalization provider routing, request shaping, streaming, and response normalization for Structured Search Providers.
- OpenAI native web_search: Covers OpenAI native web_search routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Codex native web_search: Covers Codex native web_search routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Gemini grounding: Covers Gemini grounding routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Grok web grounding: Covers Grok web grounding routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Kimi web search: Covers Kimi web search routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Provider-native citations: Covers Provider-native citations routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Model and filter routing: Covers Model and filter routing routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- webSearchProviders: Defines webSearchProviders setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.
- registerWebSearchProvider: Defines registerWebSearchProvider setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.
- webFetchProviders: Defines webFetchProviders setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.
- registerWebFetchProvider: Defines registerWebFetchProvider setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.
- public-artifact loading: Defines public-artifact loading setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.
- runtime resolution: Defines runtime resolution setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.
- contract tests: Defines contract tests setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.

Primary docs:

- `docs/tools/web.md`
- `docs/tools/brave-search.md`
- `docs/tools/tavily.md`
- `docs/tools/exa-search.md`
- `docs/tools/firecrawl.md`
- `docs/tools/perplexity-search.md`
- `docs/tools/duckduckgo-search.md`
- `docs/tools/searxng-search.md`
- `docs/tools/gemini-search.md`
- `docs/tools/grok-search.md`
- `docs/tools/kimi-search.md`
- `docs/tools/minimax-search.md`
- `docs/tools/ollama-search.md`
- `docs/plugins/sdk-subpaths.md`
- `docs/plugins/sdk-overview.md`
- `docs/plugins/manifest.md`

### 2. Setup and Diagnostics

Search anchors: Provider credentials, Default provider selection, Credential repair, Status checks, Quota errors, Cache controls, Provider diagnostics, Retry and fallback, Operator repair.

Category note: [Setup and Diagnostics](operator-setup-provider-selection-and-credential-repair.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- Provider credentials: Defines Provider credentials setup, credential, configuration, and operator verification behavior for Setup and Credential Repair.
- Default provider selection: Defines Default provider selection setup, credential, configuration, and operator verification behavior for Setup and Credential Repair.
- Credential repair: Defines Credential repair setup, credential, configuration, and operator verification behavior for Setup and Credential Repair.
- Status checks: Defines Status checks setup, credential, configuration, and operator verification behavior for Setup and Credential Repair.
- Quota errors: Covers Quota errors status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.
- Cache controls: Covers Cache controls status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.
- Provider diagnostics: Covers Provider diagnostics status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.
- Retry and fallback: Covers Retry and fallback status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.
- Operator repair: Covers Operator repair status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.

Primary docs:

- `docs/tools/web.md`
- `docs/tools/web-fetch.md`
- `docs/help/faq.md`
- `docs/reference/api-usage-costs.md`
- `docs/tools/brave-search.md`
- `docs/tools/perplexity-search.md`
- `docs/tools/tavily.md`
- `docs/tools/firecrawl.md`

### 3. Network Safety

Search anchors: Network Safety, SSRF, Redirects, Untrusted Content, web search tools network safety, ssrf, redirects, and untrusted content, network safety, ssrf, redirects, and untrusted content.

Category note: [Network Safety](network-safety-ssrf-redirects-and-untrusted-content.md)

Score decisions:

- Coverage: `Stable (84%)`
- Quality: `Stable (84%)`
- Completeness: `Stable (84%)`
- LTS: ❌

Features:

- Network Safety: Defines Network Safety authorization, trust, safety boundaries, and operator controls for Network Safety, Ssrf, Redirects, and Untrusted Content.
- SSRF: Defines SSRF authorization, trust, safety boundaries, and operator controls for Network Safety, Ssrf, Redirects, and Untrusted Content.
- Redirects: Defines Redirects authorization, trust, safety boundaries, and operator controls for Network Safety, Ssrf, Redirects, and Untrusted Content.
- Untrusted Content: Defines Untrusted Content authorization, trust, safety boundaries, and operator controls for Network Safety, Ssrf, Redirects, and Untrusted Content.

Primary docs:

- `docs/tools/web.md`
- `docs/tools/web-fetch.md`
- `docs/tools/firecrawl.md`
- `docs/tools/searxng-search.md`

### 4. Tool Availability and Fetch

Search anchors: web_search exposure, web_fetch exposure, x_search exposure, group:web policy, disabled-state diagnostics, provider/model gating, URL fetch, HTML extraction, PDF/text extraction, Safe truncation, Content citation handoff.

Category note: [Tool Availability and Fetch](tool-exposure-policy-and-runtime-tool-wiring.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Stable (80%)`
- Completeness: `Stable (82%)`
- LTS: ❌

Features:

- web_search exposure: Defines web_search exposure setup, credential, configuration, and operator verification behavior for Tool Availability and Policy.
- web_fetch exposure: Defines web_fetch exposure setup, credential, configuration, and operator verification behavior for Tool Availability and Policy.
- x_search exposure: Defines x_search exposure setup, credential, configuration, and operator verification behavior for Tool Availability and Policy.
- group:web policy: Defines group:web policy setup, credential, configuration, and operator verification behavior for Tool Availability and Policy.
- disabled-state diagnostics: Defines disabled-state diagnostics setup, credential, configuration, and operator verification behavior for Tool Availability and Policy.
- provider/model gating: Defines provider/model gating setup, credential, configuration, and operator verification behavior for Tool Availability and Policy.
- URL fetch: Covers URL fetch tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.
- HTML extraction: Covers HTML extraction tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.
- PDF/text extraction: Covers PDF/text extraction tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.
- Safe truncation: Covers Safe truncation tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.
- Content citation handoff: Covers Content citation handoff tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.

Primary docs:

- `docs/gateway/config-tools.md`
- `docs/tools/web-fetch.md`
- `docs/tools/web.md`
- `docs/help/faq.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/web-search-tools/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/web-search-tools`.
