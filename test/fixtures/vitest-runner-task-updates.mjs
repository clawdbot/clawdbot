import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Exercise the installed v5 producer through a native worker and public runner
// hooks. Standalone @vitest/runner would silently resolve ancestor v4 in worktrees.
export function createTaskUpdateFixture(firstFireAt, parent = tmpdir()) {
  const root = fs.mkdtempSync(path.resolve(parent, "vitest-task-updates-"));
  const observation = path.join(root, "observation.json");
  const packageRoot = path.dirname(fileURLToPath(import.meta.resolve("vitest/package.json")));
  // Literal module URLs keep the generated runner and preload traceable.
  const runner = fileURLToPath(new URL("./vitest-runner-task-updates.runner.mjs", import.meta.url));
  const clock = fileURLToPath(new URL("./vitest-runner-task-updates.clock.mjs", import.meta.url));
  const config = path.join(root, "vitest.config.mjs");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module","workspaces":[]}');
  fs.writeFileSync(
    path.join(root, "passive.test.mjs"),
    'test("completed case", () => {}); test("independent next case", () => {});',
  );
  fs.writeFileSync(
    config,
    `export default ${JSON.stringify({
      root,
      test: {
        globals: true,
        include: ["passive.test.mjs"],
        runner,
        execArgv: ["--import", clock],
        provide: { firstFireAt, observation },
        pool: "threads",
        maxWorkers: 1,
        fileParallelism: false,
        fsModuleCache: false,
        cache: false,
      },
    })};`,
  );
  return {
    root,
    observation,
    args: [
      path.join(packageRoot, "vitest.mjs"),
      "run",
      "--config",
      config,
      "--configLoader=native",
    ],
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: root,
      USERPROFILE: root,
      CI: "1",
      NO_COLOR: "1",
    },
  };
}
