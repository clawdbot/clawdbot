import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function copyPrWrapperFixture(repoDir: string): void {
  const sourceRoot = process.cwd();
  const source = readFileSync(join(sourceRoot, "scripts/pr"), "utf8");
  const components = /^pr_wrapper_components=\(\n([\s\S]*?)^\)/m.exec(source)?.[1];
  if (!components?.trim()) {
    throw new Error("scripts/pr has no wrapper component declaration");
  }
  // The executable trust owner supplies the closure; fixture copies must not drift.
  for (const component of components.trim().split(/\s+/)) {
    const target = join(repoDir, component);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(sourceRoot, component), target, { recursive: true });
  }
}
