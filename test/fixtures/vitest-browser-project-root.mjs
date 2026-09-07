import fs from "node:fs";
import path from "node:path";
import { createVitest } from "vitest/node";

const output = process.argv[2];
if (!output) {
  throw new Error("Expected a discovery report path");
}
const topLevelRoot = process.argv[3];
if (!topLevelRoot) {
  throw new Error("Expected a top-level project root");
}
const testRoot = process.argv[4];
if (!testRoot) {
  throw new Error("Expected a test project root");
}
const topLevelDescriptorRoot = path.relative(process.cwd(), topLevelRoot);
const testDescriptorRoot = path.relative(process.cwd(), testRoot);
const config = path.resolve("test/vitest/vitest.ui-browser.config.ts");
const reports = [];
for (const options of [
  { config },
  { config: false, projects: [{ config }] },
  { config: false, projects: [{ config, root: topLevelDescriptorRoot }] },
  { config: false, projects: [{ config, test: { root: testDescriptorRoot } }] },
]) {
  const ctx = await createVitest({
    ...options,
    project: ["chromium"],
    watch: false,
    reporters: [],
    configLoader: "runner",
    api: false,
  });
  try {
    const specifications = await ctx.globTestSpecifications();
    reports.push({
      projects: ctx.projects.map((project) => ({
        name: project.name,
        root: project.config.root,
        viteRoot: project.vite.config.root,
        setupFiles: project.config.setupFiles,
      })),
      files: specifications.map((specification) => specification.moduleId).toSorted(),
    });
  } finally {
    await ctx.close();
  }
}
fs.writeFileSync(output, JSON.stringify(reports));
