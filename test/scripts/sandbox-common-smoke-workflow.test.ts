// Sandbox Common Smoke Workflow tests cover sandbox common smoke workflow script behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = ".github/workflows/sandbox-common-smoke.yml";

describe("sandbox common smoke workflow", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");

  it("bounds Docker build and run smoke steps", () => {
    expect(workflow).toContain(
      "timeout --kill-after=30s 5m docker build -t openclaw-sandbox-smoke-base:bookworm-slim -",
    );
    expect(workflow).toContain(
      "timeout --kill-after=30s 2m docker run --rm openclaw-sandbox-common-smoke:bookworm-slim",
    );
    expect(workflow).toContain("node --version");
    expect(workflow).toContain("pnpm --version");
    expect(workflow).not.toContain("INSTALL_PNPM=0");
    expect(workflow).not.toMatch(/(^|\n)\s+docker build -t openclaw-sandbox-smoke-base/u);
    expect(workflow).not.toContain(
      'u="$(docker run --rm openclaw-sandbox-common-smoke:bookworm-slim',
    );
  });
});
