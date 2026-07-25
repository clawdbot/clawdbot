# LiNKbrain Agent Coordination Handover Prompt

Give the following prompt to the main Codex Desktop Orchestrator working in the LiNKbrain repository.

---

You are the main Codex Desktop Orchestrator working in the LiNKbrain repository:

```text
/Users/linktrend/Projects/LiNKbrain
```

## Objective

Design and implement LiNKbrain as the centralized coordination, knowledge, and memory system for AI agents working across Carlos's repositories, beginning with OpenClaw Prime.

This work belongs in LiNKbrain because LiNKbrain must own the shared storage contracts, APIs, access control, knowledge promotion, agent identity, synchronization, and retrieval behavior. OpenClaw Prime should later consume LiNKbrain through a small integration rather than owning the central system.

## Operating Context

Carlos uses agents across:

- Codex Desktop
- Cursor Local Agents
- Cursor Cloud Agents
- ChatGPT Work Agents
- macOS desktop applications
- Remote Cursor workspaces
- iOS applications
- Multiple computers

Each platform and machine may have these roles:

- Orchestrator
- Profile agent, such as Lisa or David
- Feature agent

Carlos may instruct any agent directly. Orchestrators coordinate shared state but are not permission gates.

OpenClaw Prime currently uses a repository-local Stage 1 documentation system containing:

- Agent briefing
- Coordination protocol
- Current-status dashboard
- Active and completed session records
- Append-only handoffs
- Branch and worktree ownership rules

Repository reference:

```text
/Users/linktrend/Projects/openclaw_prime
```

Read these OpenClaw Prime files as reference only before designing migration:

```text
AGENTS.md
docs/agent-briefing.md
docs/agent-coordination.md
docs/current-status.md
docs/agent-sessions/TEMPLATE.md
docs/handoffs/TEMPLATE.md
docs/handoffs/2026-07-24-1845-codex-desktop-promotion-complete.md
```

Do not modify OpenClaw Prime during the initial LiNKbrain design phase.

## Required LiNKbrain Outcome

Agents must be able to:

1. Register a unique identity containing platform, machine, application surface, local/cloud execution, repository, role, session, and assigned scope.
2. Announce active work and the files, branches, runtime components, profiles, services, or deployment areas they own.
3. Detect overlapping work before modifying shared areas.
4. Record milestones, decisions, evidence, commands, tests, blockers, unresolved questions, and handoffs.
5. Close or supersede sessions without erasing history.
6. Retrieve the current state of a repository, profile, feature, or deployment before beginning work.
7. Retrieve relevant previous decisions and handoffs without loading unrelated private information.
8. Distinguish verified facts, agent conclusions, unresolved unknowns, historical claims, and superseded information.
9. Preserve provenance for every record.
10. Support append-only corrections rather than silent history rewriting.
11. Work from Codex, Cursor, ChatGPT, cloud agents, local agents, remote workspaces, and mobile surfaces.
12. Continue safely during temporary LiNKbrain unavailability and reconcile later without duplicating or overwriting records.
13. Prevent one agent from falsely claiming ownership of another agent's session.
14. Allow Carlos to assign any agent directly.
15. Allow a Librarian process to review submitted information and promote suitable material into shared general knowledge.
16. Keep repository state, profile-specific state, personal memory, secrets, credentials, and private communications in separate access-controlled domains.

## Integration Direction

LiNKbrain should expose a stable agent-facing interface. Investigate the repository before choosing the exact implementation, but consider:

- MCP tools for interactive Codex, Cursor, and ChatGPT agents.
- A documented HTTP API or SDK where MCP is unavailable.
- Agent registration and heartbeat.
- Session and ownership records.
- Current-state queries.
- Knowledge and decision submission.
- Handoff submission.
- Conflict detection.
- Librarian review and promotion.
- Search and scoped retrieval.
- Idempotency and offline reconciliation.
- Authentication, authorization, audit history, and redaction.

Do not assume every platform supports automatic background updates or native agent-to-agent messaging. The shared LiNKbrain records must remain authoritative.

Do not make GitHub the live synchronization database. Git remains source control for repository changes, while LiNKbrain owns live coordination and institutional memory.

## Required Approach

1. Read all LiNKbrain repository instructions, architecture, documentation, current status, schemas, database design, APIs, security rules, and existing work.
2. Inspect the repository's current Git state, branches, worktrees, uncommitted changes, active sessions, and recent handoffs.
3. Check for existing maintained open-source components or protocols that already solve parts of this problem.
4. Identify what LiNKbrain already supports and what is genuinely missing.
5. Compare the existing implementation with the OpenClaw Prime Stage 1 coordination system.
6. Separate:
   - Existing working capability
   - Partially implemented capability
   - Missing capability
   - Proposed future capability
7. Produce an architecture and migration plan before implementing substantial changes.
8. Prefer extending existing LiNKbrain contracts over creating a parallel coordination system.
9. Use one isolated branch/worktree for the task.
10. Do not modify OpenClaw Prime, Lisa's deployment, credentials, external services, or production data without separate approval.
11. Do not add paid services without Carlos's approval.
12. Do not expose private memory, credentials, messages, email contents, tokens, or personal information.
13. Use test or synthetic agent records during development.
14. Require Carlos's approval before destructive migrations, schema-version changes, production deployment, or irreversible data conversion.

## First Deliverable

Before implementation, provide Carlos with a plain-English report containing:

- What LiNKbrain already does.
- What is missing for multi-platform agent coordination.
- Whether MCP, HTTP API, SDKs, or a combination should be used.
- The proposed agent identity and session model.
- The proposed knowledge-submission and Librarian-promotion flow.
- The proposed security and privacy boundaries.
- How conflict detection will work.
- How offline agents will reconcile.
- How OpenClaw Prime's repository documentation will transition from Stage 1 to LiNKbrain without losing history.
- Which minimal OpenClaw Prime integration will eventually be required.
- The implementation phases and validation plan.
- Risks, unknowns, and decisions Carlos must approve.
- Your confidence level.

Do not begin substantial implementation until you understand the LiNKbrain repository and this objective with greater than 98% confidence. If confidence is lower, ask grouped questions in plain English and explain why each answer matters.

After Carlos approves the architecture, implement the LiNKbrain-owned foundation first. OpenClaw Prime consumer wiring must be handled as a later, separately reviewed integration.
