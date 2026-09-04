import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { digestClawHubSkillTree } from "./skill-tree-digest.js";

it("preserves the installed tree fingerprint and root-only metadata exclusions", async () => {
  await withTestDir({ prefix: "openclaw-skill-digest-" }, async (dir) => {
    await fs.mkdir(path.join(dir, "empty"));
    const files = {
      "SKILL.md": "# Synthetic skill\n",
      "a.bin": Buffer.from([0, 255, 128, 195, 40]),
      "nested/.clawhub/metadata.txt": "included metadata\n",
      "nested/Ω.txt": "snowman ☃\n",
      ".clawhub/origin.json": '{"ignored":true}\n',
      ".clawdhub/provenance.json": '{"ignored":true}\n',
    };
    for (const [relative, content] of Object.entries(files).toReversed()) {
      const target = path.join(dir, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    const original = "sha256:d95a509f264aae093c5e968a6a48c1dee9c98f0bf3397477b7efd5176745a02a";
    await expect(digestClawHubSkillTree(dir)).resolves.toBe(original);

    await fs.writeFile(path.join(dir, ".clawhub/origin.json"), "changed metadata\n");
    await expect(digestClawHubSkillTree(dir)).resolves.toBe(original);

    await fs.writeFile(path.join(dir, "nested/.clawhub/metadata.txt"), "changed metadata\n");
    await expect(digestClawHubSkillTree(dir)).resolves.toBe(
      "sha256:ceb96e5c4fcba5d19e39160f3d4075e57783e5208b9f9777d2dbbe08e432125a",
    );

    await fs.writeFile(path.join(dir, "a.bin"), Buffer.from([0, 255, 128, 195, 41]));
    await expect(digestClawHubSkillTree(dir)).resolves.toBe(
      "sha256:598bd6311fc6a1c24eec07ad2f8c1f86a2bb556b19ff73ef6a1e738b49dfbbd9",
    );
  });
});
