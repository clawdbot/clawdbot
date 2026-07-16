import { describe, expect, it } from "vitest";
import {
  hasDiscoveryLabels,
  reportsDiscoveryScopeLeak,
  reportsMissingDiscoveryFiles,
} from "./discovery-eval.js";

describe("qa discovery evaluation", () => {
  it("accepts rich discovery reports that explicitly confirm all required files were read", () => {
    const report = `
Worked
- Read all three requested files: repo/qa/scenarios/index.md, repo/extensions/qa-lab/src/suite.ts, and repo/docs/help/testing.md.
Failed
- None.
Blocked
- Runtime execution not attempted here.
Follow-up
- Run the live suite next.

The helper text mentions banned phrases like "not present", "missing files", "blocked by missing", and "could not inspect", but only as quoted examples.
`.trim();

    expect(hasDiscoveryLabels(report)).toBe(true);
    expect(reportsMissingDiscoveryFiles(report)).toBe(false);
    expect(reportsDiscoveryScopeLeak(report)).toBe(false);
  });

  it("accepts numeric 'all 4 required files read' confirmations", () => {
    const report = `
Worked
- Source: repo/qa/scenarios/index.md, repo/extensions/qa-lab/src/suite.ts, repo/docs/help/testing.md
- all 3 required files read.
Failed
- None.
Blocked
- No runtime execution in this pass.
Follow-up
- Run the live suite next.

The report may quote phrases like "not present" while describing the evaluator, but the files were read.
`.trim();

    expect(hasDiscoveryLabels(report)).toBe(true);
    expect(reportsMissingDiscoveryFiles(report)).toBe(false);
    expect(reportsDiscoveryScopeLeak(report)).toBe(false);
  });

  it("accepts claude-style 'all four files retrieved' discovery summaries", () => {
    const report = `
Worked
- All three files retrieved. Now let me compile the protocol report.
- All three mandated files read successfully: repo/qa/scenarios/index.md, repo/extensions/qa-lab/src/suite.ts, repo/docs/help/testing.md.
Failed
- None.
Blocked
- Runtime execution not attempted here.
Follow-up
- Run the live suite next.
`.trim();

    expect(hasDiscoveryLabels(report)).toBe(true);
    expect(reportsMissingDiscoveryFiles(report)).toBe(false);
    expect(reportsDiscoveryScopeLeak(report)).toBe(false);
  });

  it("still flags genuine file-miss language when the report never confirms the required reads", () => {
    const report = `
Worked
- Read some of the requested files.
Failed
- repo/docs/help/testing.md was not present.
Blocked
- Could not inspect the remaining refs.
Follow-up
- Fix the workspace mount.
`.trim();

    expect(hasDiscoveryLabels(report)).toBe(true);
    expect(reportsMissingDiscoveryFiles(report)).toBe(true);
    expect(reportsDiscoveryScopeLeak(report)).toBe(false);
  });

  it("flags discovery replies that drift into unrelated suite wrap-up claims", () => {
    const report = `
Worked
- All three requested files were read: repo/qa/scenarios/index.md, repo/extensions/qa-lab/src/suite.ts, repo/docs/help/testing.md.
Failed
- None.
Blocked
- Runtime execution not attempted here.
Follow-up
- Run the live suite next.

Final QA tally update: all mandatory scenarios resolved. QA run complete.
`.trim();

    expect(hasDiscoveryLabels(report)).toBe(true);
    expect(reportsMissingDiscoveryFiles(report)).toBe(false);
    expect(reportsDiscoveryScopeLeak(report)).toBe(true);
  });
});
