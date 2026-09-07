import type { SkillsLibraryReadResult } from "../../../packages/gateway-protocol/src/index.ts";

export function buildSkillLibraryMock(): [
  SkillsLibraryReadResult,
  SkillsLibraryReadResult,
  SkillsLibraryReadResult,
] {
  const now = Date.parse("2026-08-25T12:00:00Z");
  const seeds = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "release-notes",
      owner: "profile-alice",
      description: "Draft concise release notes from a reviewed change list.",
      shared: false,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      slug: "release-notes",
      owner: "profile-bob",
      description: "Prepare the team's customer-facing release summary.",
      shared: true,
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      slug: "support-triage",
      owner: null,
      description: "Turn a support report into a reproducible investigation.",
      shared: true,
    },
  ] as const;
  const build = (seed: (typeof seeds)[number]): SkillsLibraryReadResult => ({
    entry: {
      skillId: seed.id,
      slug: seed.slug,
      name: `s_${seed.slug.replaceAll("-", "_").slice(0, 9)}_${seed.id.replaceAll("-", "").slice(0, 20)}`,
      description: seed.description,
      ownerProfileId: seed.owner,
      ownerLabel: seed.owner === null ? "Team" : seed.owner === "profile-alice" ? "Alice" : "Bob",
      authorProfileId: seed.owner ?? "profile-bob",
      shared: seed.shared,
      enabled: true,
      removed: false,
      revision: "1".repeat(64),
      createdAt: now,
      updatedAt: now,
      canEdit: seed.owner === "profile-alice",
    },
    content: `---\nname: ${seed.slug}\ndescription: ${seed.description}\n---\n\n# ${seed.slug}\n\nRead references/checklist.md before beginning.\n`,
    files: [
      {
        path: "references/checklist.md",
        content: "# Checklist\r\n\r\n- Confirm the behavior.\r\n- Record the evidence.\r\n",
        encoding: "utf8",
        executable: true,
      },
      { path: "assets/sample.bin", content: "AAECA/7/", encoding: "base64" },
    ],
    revisions: [{ revision: "1".repeat(64), createdAt: now }],
  });
  return [build(seeds[0]), build(seeds[1]), build(seeds[2])];
}
