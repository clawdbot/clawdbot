// Runs test-projects with an explicit high worker budget for max-throughput checks.
process.env.OPENCLAW_VITEST_MAX_WORKERS = "8";

await import("./test-projects.mjs");
