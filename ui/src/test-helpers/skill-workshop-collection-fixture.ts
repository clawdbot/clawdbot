export function createSkillWorkshopCollectionFixture() {
  const updatedAt = "2026-08-16T10:00:00.000Z";
  const installedSkills = [
    "release-review",
    "log-search",
    "change-review",
    "safe-rollout",
    "data-export",
  ].map((name) => ({
    name,
    skillKey: name,
    description: `Current ${name.replaceAll("-", " ")} procedure.`,
  }));
  const history = Array.from({ length: 31 }, (_, index) => ({
    id: `history-${index}`,
    kind: "create",
    status: index < 22 ? "applied" : "stale",
    title: `Historical procedure ${index + 1}`,
    description: "An earlier draft kept for reference.",
    skillKey: index < 5 ? installedSkills[index]!.skillKey : `removed-skill-${index}`,
    skillName: index < 5 ? installedSkills[index]!.name : `removed-skill-${index}`,
    createdAt: updatedAt,
    updatedAt,
    scanState: "clean",
  }));
  const pending = {
    ...history[0],
    id: "pending-review",
    status: "pending",
    title: "Improve release review",
    description: "Check rollback before release.",
    skillKey: "release-review",
    skillName: "release-review",
  };
  const proposals = [pending, ...history];
  const manifest = {
    schema: "openclaw.skill-workshop.proposals-manifest.v1",
    updatedAt,
    installedSkills,
    proposals,
  };
  const emptyManifest = { ...manifest, installedSkills: [], proposals: [] };
  const historyStatus = {
    schema: "openclaw.skill-workshop.history-scan.v1",
    hasScanned: false,
    reviewedSessions: 0,
    ideasFound: 0,
    hasMore: false,
    lastScanReviewed: 0,
    lastScanIdeas: 0,
  };
  return {
    manifest,
    emptyManifest,
    featureMethods: [
      "skills.proposals.apply",
      "skills.proposals.evaluate",
      "skills.proposals.reject",
      "skills.proposals.requestRevision",
      "skills.proposals.historyScan",
      "skills.proposals.historyStatus",
      "config.get",
    ],
    responses: {
      "skills.proposals.historyStatus": historyStatus,
      "skills.proposals.historyScan": { ...historyStatus, hasScanned: true },
      "config.get": {
        hash: "workshop-config",
        config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
        sourceConfig: { skills: { workshop: { autonomous: { mode: "auto" } } } },
        raw: "{}",
        valid: true,
        issues: [],
      },
      "agents.list": {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Main" },
          { id: "writer", name: "Writer" },
        ],
      },
      "skills.proposals.list": {
        cases: [
          { match: { agentId: "main" }, response: manifest },
          { match: { agentId: "writer" }, response: emptyManifest },
        ],
      },
      "skills.workshop.read": {
        cases: installedSkills.map((skill) => ({
          match: { name: skill.name },
          response: {
            ...skill,
            content: `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n# ${skill.name}\n\nCurrent instructions after collection review.\n\n## Verify\n\n1. Check the current result.\n2. Report what changed.\n\n| Outcome | Action |\n| --- | --- |\n| Ready | Continue |\n| Failed | Stop |\n\nEnd of current instructions.\n`,
          },
        })),
      },
      "skills.proposals.inspect": {
        cases: proposals.map((proposal) => ({
          match: { proposalId: proposal.id },
          response: {
            record: {
              ...proposal,
              proposedVersion: "1",
              draftHash: "a".repeat(64),
              target: { skillKey: proposal.skillKey, skillName: proposal.skillName },
            },
            revisionHash: "b".repeat(64),
            content: `---\nname: ${proposal.skillName}\ndescription: ${proposal.description}\n---\n\n# ${proposal.title}\n\n${proposal.status === "pending" ? "Pending instructions waiting for review." : "Historical draft instructions."}\n`,
            supportFiles: [
              { path: "references/procedure.md", content: "Retained supporting evidence." },
            ],
          },
        })),
      },
    },
  };
}
