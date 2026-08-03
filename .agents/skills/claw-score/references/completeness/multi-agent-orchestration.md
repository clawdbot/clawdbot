# Multi-Agent Orchestration Completeness

Use this rubric when assigning category Completeness scores for the
`multi-agent-orchestration` surface.

## Surface-Specific Scoring Questions

For each category, ask:

- Can an operator configure and run the category workflow end to end?
- Are the taxonomy features present as supported user paths rather than partial config fragments?
- Are setup, normal operation, status or inspection, recovery, and removal paths represented where relevant?
- Are channel, account, workspace, auth, task, and delegate variants covered where the category expects them?
- Do known gaps leave major coordination or isolation branches missing?

## Surface-Specific Guidance

Variation from the default completeness process:

- Completeness is the operator-facing system for setup, isolation, conversation routing, account routing, specialist lanes, delegate identity, status, recovery, and safe defaults.
- A complete category lets multiple agents be created, isolated, routed, delegated, and inspected without implicit cross-agent leakage.
- Undocumented config, nondeterministic routing, or unclear ownership of state, credentials, and outbound delivery are material completeness gaps.

## Category Scope

- Agent Setup: add agents, agent list/delete, identity files, non-interactive setup, and single-agent default.
- Agent Isolation: workspace separation, state separation, auth separation, session separation, and tool profiles.
- Conversation Routing: agent selection, route precedence, default fallback, peer overrides, and cross-channel examples.
- Account Routing: multi-account setup, account selection, default accounts, account credentials, and delivery targets.
- Specialist Lanes: lane contracts, background handoff, concurrency controls, priority controls, and coordinator handoff.
- Delegate Identities: named delegates, authority model, delegate tiers, identity delegation, and organizational assistants.
