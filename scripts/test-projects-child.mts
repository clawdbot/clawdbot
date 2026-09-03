// The delegating runner owns reporting after this execution process closes.
import { exitVitestBySignal } from "./lib/vitest-process.mts";
import { runTestProjects } from "./test-projects-run.mts";

await runTestProjects(exitVitestBySignal);
