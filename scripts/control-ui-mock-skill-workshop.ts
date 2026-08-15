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
  return {
    list: {
      schema: "openclaw.skill-workshop.proposals-manifest.v1",
      updatedAt: new Date(baseTime - hour).toISOString(),
      proposals,
    },
    inspect: {
      cases: proposals.map((proposal) => ({
        match: { proposalId: proposal.id },
        response: {
          record: {
            ...proposal,
            proposedVersion: "2",
            target: { skillName: proposal.skillName, skillKey: proposal.skillKey },
          },
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
