// Skill plugin fixtures create plugin-backed skill layouts for tests.
import fs from "node:fs/promises";
import path from "node:path";

/** Writes a minimal plugin fixture that exposes one bundled skill. */
export async function writePluginWithSkill(params: {
  pluginRoot: string;
  pluginId: string;
  skillId: string;
  skillDescription: string;
}) {
  await fs.mkdir(path.join(params.pluginRoot, "skills", params.skillId), { recursive: true });
  await fs.writeFile(
    path.join(params.pluginRoot, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.pluginId,
        skills: ["./skills"],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    ),
    "utf-8",
  );
  await fs.writeFile(path.join(params.pluginRoot, "index.ts"), "export {};\n", "utf-8");
  await fs.writeFile(
    path.join(params.pluginRoot, "skills", params.skillId, "SKILL.md"),
    `---\nname: ${params.skillId}\ndescription: ${params.skillDescription}\n---\n`,
    "utf-8",
  );
}
