import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const buildFile = "apps/android/app/build.gradle.kts";

describe("Android Mermaid asset generation", () => {
  it("builds through the package-local pnpm context", () => {
    const build = readFileSync(buildFile, "utf8");
    const task = build.slice(
      build.indexOf('tasks.register<Exec>("generateMermaidAssets")'),
      build.indexOf('tasks.matching { task -> task.name == "preBuild" }'),
    );

    expect(task).toContain('commandLine("pnpm", "--dir", "packages/mermaid-renderer", "build")');
    expect(task).not.toContain(
      'commandLine("pnpm", "--filter", "@openclaw/mermaid-renderer", "build")',
    );
  });
});
