export function buildSkillWorkshopMocks(baseTime: number) {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const proposals = [
    {
      id: "prop-release-tweets",
      kind: "update",
      status: "pending",
      title: "Tighten release tweet drafting",
      description: "Capture the changelog-to-tweet flow the agent keeps re-deriving.",
      skillName: "release-tweets",
      skillKey: "release-tweets",
      createdAt: new Date(baseTime - 2 * hour).toISOString(),
      updatedAt: new Date(baseTime - hour).toISOString(),
      scanState: "clean",
    },
    {
      id: "prop-crawler-etiquette",
      kind: "create",
      status: "pending",
      title: "Add crawler etiquette skill",
      description: "Rate limits and robots.txt handling learned during the docs sweep.",
      skillName: "crawler-etiquette",
      skillKey: "crawler-etiquette",
      createdAt: new Date(baseTime - 3 * day).toISOString(),
      updatedAt: new Date(baseTime - 2 * day).toISOString(),
      scanState: "clean",
    },
    {
      id: "prop-changelog-style",
      kind: "update",
      status: "applied",
      title: "Changelog bullet style",
      description: "One bullet per entry, no hard wraps.",
      skillName: "changelog-style",
      skillKey: "changelog-style",
      createdAt: new Date(baseTime - 6 * day).toISOString(),
      updatedAt: new Date(baseTime - 5 * day).toISOString(),
      scanState: "clean",
    },
  ];
  const revisionHash = "b".repeat(64);
  const recordFor = (proposal: (typeof proposals)[number]) => ({
    schema: "openclaw.skill-workshop.proposal.v1",
    ...proposal,
    createdBy: { type: "agent", id: "main" },
    proposedVersion: "2",
    draftFile: "PROPOSAL.md",
    draftHash: "a".repeat(64),
    target: { skillName: proposal.skillName, skillKey: proposal.skillKey },
    scan: { state: proposal.scanState, scannedAt: new Date(baseTime - hour).toISOString() },
  });
  const evaluation = {
    id: "evaluation-control-ui-mock",
    proposedVersion: "2",
    revisionHash,
    trigger: "manual",
    startedAt: new Date(baseTime - 20_000).toISOString(),
    completedAt: new Date(baseTime - 18_000).toISOString(),
    outcomes: [
      {
        pluginId: "fixture-quality",
        pluginVersion: "1.0.0",
        evaluatorId: "readability",
        status: "completed",
        result: {
          summary: "The workflow is bounded and includes a recovery step.",
          decision: "allow",
          decisionReason: "No blocking findings in the sanitized fixture.",
        },
      },
    ],
  };
  return {
    list: {
      schema: "openclaw.skill-workshop.proposals-manifest.v1",
      updatedAt: new Date(baseTime - hour).toISOString(),
      proposals,
      installedSkills: [],
    },
    inspect: {
      cases: proposals.map((proposal) => ({
        match: { proposalId: proposal.id },
        response: {
          record: {
            ...recordFor(proposal),
            ...(proposal.id === "prop-release-tweets" ? { evaluation } : {}),
          },
          revisionHash,
          content: [
            `# ${proposal.title}`,
            "",
            proposal.description,
            "",
            "## Steps",
            "1. Gather the source material.",
            "2. Apply the documented workflow.",
          ].join("\n"),
          supportFiles: [],
        },
      })),
    },
    evaluate: {
      cases: proposals.map((proposal) => ({
        match: { proposalId: proposal.id },
        response: { record: { ...recordFor(proposal), evaluation }, evaluation },
      })),
    },
    apply: {
      cases: proposals.map((proposal) => ({
        match: { proposalId: proposal.id },
        response: {
          record: {
            ...recordFor(proposal),
            status: "applied",
            appliedAt: new Date(baseTime).toISOString(),
          },
          targetSkillFile: `.agents/skills/${proposal.skillKey}/SKILL.md`,
        },
      })),
    },
    reject: {
      cases: proposals.map((proposal) => ({
        match: { proposalId: proposal.id },
        response: {
          ...recordFor(proposal),
          status: "rejected",
          rejectedAt: new Date(baseTime).toISOString(),
        },
      })),
    },
    requestRevision: { runId: "skill-workshop-revision-mock", status: "started" },
    historyStatus: {
      schema: "openclaw.skill-workshop.history-scan.v1",
      hasScanned: false,
      reviewedSessions: 0,
      ideasFound: 0,
      hasMore: false,
      lastScanReviewed: 0,
      lastScanIdeas: 0,
    },
    historyScan: {
      schema: "openclaw.skill-workshop.history-scan.v1",
      hasScanned: true,
      reviewedSessions: 34,
      ideasFound: 2,
      hasMore: true,
      lastScanReviewed: 20,
      lastScanIdeas: 2,
      lastScanAt: new Date(baseTime).toISOString(),
      oldestReviewedAt: new Date(baseTime - 25 * day).toISOString(),
      newestReviewedAt: new Date(baseTime).toISOString(),
    },
  };
}
