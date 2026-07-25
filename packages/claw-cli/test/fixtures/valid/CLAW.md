---
schemaVersion: 1
agent:
  id: incident-triage
  name: Incident triage
  description: Reviews incidents and prepares an evidence-backed handoff.
metadata:
  openclaw.config: profiles/openclaw.yml
workspace:
  bootstrapFiles:
    AGENTS.md:
      source: workspace/AGENTS.md
    SOUL.md:
      source: workspace/SOUL.md
packages: []
mcpServers: {}
cronJobs: []
---
