// Importing this public entrypoint also starts the serial/max/import aliases.
import { runVitestCli } from "./lib/vitest-process.mts";
import { runTestProjects } from "./test-projects-run.mts";

void runVitestCli("test", runTestProjects);
