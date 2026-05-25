process.env.OPENCLAW_TEST_PROJECTS_SERIAL = "1";
process.env.OPENCLAW_VITEST_MAX_WORKERS = "1";

await import("./test-projects.mjs");
