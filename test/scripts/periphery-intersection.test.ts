import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  buildSummary,
  filterIgnoredFindings,
  formatAnnotation,
  intersectFindings,
  parseRepoLocation,
  validateFindings,
} from "../../scripts/periphery-intersection.mjs";

const WORKFLOW_PATH = ".github/workflows/shared-openclawkit-periphery.yml";
const FINDING_SOURCE = "../shared/OpenClawKit/Sources/OpenClawKit/Example.swift";

type WorkflowStep = {
  id?: string;
  name?: string;
  run?: string;
  with?: { name?: string; path?: string; script?: string };
};

type Workflow = {
  jobs?: Record<
    string,
    {
      name?: string;
      needs?: string[] | string;
      "runs-on"?: string;
      steps?: WorkflowStep[];
    }
  >;
};

function finding(overrides: Record<string, unknown> = {}) {
  return {
    ids: ["s:11OpenClawKit7ExampleV"],
    kind: "struct",
    location: `${FINDING_SOURCE}:12:8`,
    name: "Example",
    ...overrides,
  };
}

function withSharedSource(source: string, test: (repoRoot: string) => void) {
  const repoRoot = mkdtempSync(join(tmpdir(), "openclaw-periphery-intersection-"));
  const sourceFile = join(repoRoot, "apps/shared/OpenClawKit/Sources/OpenClawKit/Example.swift");
  mkdirSync(dirname(sourceFile), { recursive: true });
  writeFileSync(sourceFile, source);
  try {
    test(repoRoot);
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
}

describe("Periphery intersection", () => {
  it("matches exact Swift USRs instead of declaration names", () => {
    const sameNameDifferentUsr = finding({ ids: ["s:11OpenClawKit7ExampleV_other"] });
    expect(intersectFindings([finding()], [sameNameDifferentUsr])).toEqual([]);
    expect(intersectFindings([finding()], [finding()])).toEqual([finding()]);
  });

  it("matches any USR emitted for a declaration compiled into multiple iOS modules", () => {
    const ios = finding({ ids: ["s:16OpenClawWatchApp7ExampleV", "s:11OpenClawKit7ExampleV"] });
    expect(intersectFindings([ios], [finding()])).toEqual([ios]);
  });

  it("sorts findings deterministically", () => {
    const later = finding({
      ids: ["s:11OpenClawKit5LaterV"],
      location: "../shared/OpenClawKit/Sources/OpenClawKit/Later.swift:2:1",
      name: "Later",
    });
    expect(intersectFindings([later, finding()], [finding(), later])).toEqual([finding(), later]);
  });

  it("honors bare Periphery ignore comments on or above declarations", () => {
    withSharedSource(
      [
        "// periphery:ignore - exported package surface",
        "public struct Example {}",
        "",
        'public init(value: String = "value") {} // periphery:ignore - exported initializer',
      ].join("\n"),
      (repoRoot) => {
        const declaration = finding({ location: `${FINDING_SOURCE}:2:8` });
        const inline = finding({ location: `${FINDING_SOURCE}:4:8` });
        expect(filterIgnoredFindings([declaration, inline], repoRoot)).toEqual([]);
      },
    );
  });

  it("does not treat scoped Periphery commands as bare ignores", () => {
    withSharedSource(
      ["// periphery:ignore:parameters value", "public struct Example {}"].join("\n"),
      (repoRoot) => {
        const command = finding({ location: `${FINDING_SOURCE}:2:8` });
        expect(filterIgnoredFindings([command], repoRoot)).toEqual([command]);
      },
    );
  });

  it("fails closed when a finding has no USR", () => {
    expect(() => validateFindings([finding({ ids: [] })], "iOS")).toThrow(
      "iOS finding 0 has no usable Swift USR",
    );
  });

  it("rejects findings outside shared OpenClawKit", () => {
    expect(() =>
      validateFindings([finding({ location: "Sources/App.swift:1:1" })], "macOS"),
    ).toThrow("macOS finding 0 is outside shared OpenClawKit sources");
  });

  it("maps relative scan locations to repository annotations", () => {
    expect(parseRepoLocation(finding().location)).toEqual({
      column: "8",
      file: "apps/shared/OpenClawKit/Sources/OpenClawKit/Example.swift",
      line: "12",
    });
    expect(formatAnnotation(finding())).toBe(
      "::error file=apps/shared/OpenClawKit/Sources/OpenClawKit/Example.swift,line=12,col=8,title=Dead shared Swift code::struct Example",
    );
  });

  it("reports the zero-findings policy in the summary", () => {
    expect(buildSummary([])).toContain("No declarations were reported dead by both");
    expect(buildSummary([finding()])).toContain("Found 1 shared Swift declaration");
  });
});

describe("shared OpenClawKit Periphery workflow", () => {
  const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;

  it("runs two consumer scans and a same-run intersection", () => {
    expect(workflow.jobs?.["scan-ios"]?.name).toBe("Scan shared kit from iOS");
    expect(workflow.jobs?.["scan-macos"]?.name).toBe("Scan shared kit from macOS");
    expect(workflow.jobs?.intersect?.needs).toEqual(["scope", "scan-ios", "scan-macos"]);
    expect(workflow.jobs?.["scan-ios"]?.["runs-on"]).toContain("github.run_attempt > 1");
    expect(workflow.jobs?.["scan-macos"]?.["runs-on"]).toContain("github.run_attempt > 1");

    const iosUpload = workflow.jobs?.["scan-ios"]?.steps?.find(
      (step) => step.name === "Upload iOS consumer report",
    );
    const macosUpload = workflow.jobs?.["scan-macos"]?.steps?.find(
      (step) => step.name === "Upload macOS consumer report",
    );
    expect(iosUpload?.with?.name).toContain("shared-periphery-ios-");
    expect(macosUpload?.with?.name).toContain("shared-periphery-macos-");
  });

  it("retains the generated protocol contract and leaves findings for the intersection", () => {
    for (const jobName of ["scan-ios", "scan-macos"]) {
      const scan = workflow.jobs?.[jobName]?.steps?.find((step) => step.name === "Scan shared kit");
      expect(scan?.run).toContain("--report-include '../shared/OpenClawKit/Sources/**'");
      expect(scan?.run).toContain(
        "--retain-files '../shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift'",
      );
      expect(scan?.run).not.toContain("--strict");
    }
    const macosScan = workflow.jobs?.["scan-macos"]?.steps?.find(
      (step) => step.name === "Scan shared kit",
    );
    expect(macosScan?.run).not.toContain("--exclude-tests");
  });
});
