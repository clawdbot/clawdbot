import { describe, expect, it } from "vitest";
import {
  crabboxProviderChain,
  crabboxWorkloadHydrateJob,
  crabboxWorkloadServerType,
  normalizeCrabboxWorkload,
  selectReadyCrabboxProvider,
} from "../../scripts/crabbox-routing-policy.mjs";

const advertisedProviders = ["aws", "azure", "blacksmith-testbox", "daytona"];

describe("Crabbox routing policy", () => {
  it("normalizes supported workload aliases", () => {
    expect(normalizeCrabboxWorkload("check")).toBe("ci-fast");
    expect(normalizeCrabboxWorkload("docker")).toBe("ci-docker");
    expect(normalizeCrabboxWorkload("release")).toBe("release-proof");
    expect(normalizeCrabboxWorkload("unknown")).toBeNull();
  });

  it.each([
    ["ci-fast", "azure", "Standard_D4ads_v6"],
    ["ci-fast", "aws", "c7a.4xlarge"],
    ["ci-proof", "azure", "Standard_D16ads_v6"],
    ["ci-proof", "aws", "c7a.8xlarge"],
    ["ci-docker", "azure", "Standard_D16ads_v6"],
    ["ci-docker", "aws", "c7a.8xlarge"],
    ["release-proof", "azure", "Standard_D16ads_v6"],
    ["release-proof", "aws", "c7a.8xlarge"],
  ] as const)("sizes %s automatic %s fallback as %s", (workload, provider, expected) => {
    expect(crabboxWorkloadServerType({ workload, provider, target: "linux" })).toBe(expected);
  });

  it("uses Docker-required hydration only for Linux Docker CI", () => {
    expect(crabboxWorkloadHydrateJob({ workload: "ci-docker", target: "linux" })).toBe(
      "hydrate-docker",
    );
    expect(crabboxWorkloadHydrateJob({ workload: "ci-fast", target: "linux" })).toBe("");
    expect(crabboxWorkloadHydrateJob({ workload: "ci-docker", target: "windows" })).toBe("");
  });

  it("treats Crabbox's empty target default as Linux", () => {
    expect(
      crabboxWorkloadServerType({
        workload: "ci-fast",
        provider: "azure",
        target: "",
      }),
    ).toBe("Standard_D4ads_v6");
  });

  it("leaves Daytona and non-Linux sizing with their provider owners", () => {
    expect(
      crabboxWorkloadServerType({
        workload: "ci-fast",
        provider: "daytona",
        target: "linux",
      }),
    ).toBe("");
    expect(
      crabboxWorkloadServerType({
        workload: "ci-proof",
        provider: "azure",
        target: "windows",
      }),
    ).toBe("");
    expect(
      crabboxWorkloadServerType({
        workload: "ci-proof",
        provider: "aws",
        target: "macos",
      }),
    ).toBe("");
  });

  it("routes CI checks through Blacksmith, Daytona, Azure, then AWS", () => {
    expect(
      crabboxProviderChain({
        workload: "ci-fast",
        configuredProvider: "blacksmith-testbox",
        target: "linux",
        advertisedProviders,
      }),
    ).toEqual(["blacksmith-testbox", "daytona", "azure", "aws"]);
  });

  it("does not let persistent cloud config outrank the CI policy", () => {
    expect(
      crabboxProviderChain({
        workload: "ci-proof",
        configuredProvider: "aws",
        target: "linux",
        advertisedProviders,
      }),
    ).toEqual(["blacksmith-testbox", "daytona", "azure", "aws"]);
  });

  it("keeps Docker and release proof off Daytona", () => {
    for (const workload of ["ci-docker", "release-proof"] as const) {
      expect(
        crabboxProviderChain({
          workload,
          configuredProvider: "daytona",
          target: "linux",
          advertisedProviders,
        }),
      ).toEqual(["blacksmith-testbox", "azure", "aws"]);
    }
  });

  it("prefers Daytona for interactive Linux work", () => {
    expect(
      crabboxProviderChain({
        workload: "interactive",
        configuredProvider: "blacksmith-testbox",
        target: "linux",
        advertisedProviders,
      }),
    ).toEqual(["daytona", "azure", "aws"]);
  });

  it("keeps untrusted work off Blacksmith and Daytona pending isolation proof", () => {
    expect(
      crabboxProviderChain({
        workload: "untrusted",
        configuredProvider: "blacksmith-testbox",
        target: "linux",
        advertisedProviders,
      }),
    ).toEqual(["azure", "aws"]);
  });

  it("uses Azure then AWS for Windows and only AWS for macOS", () => {
    expect(
      crabboxProviderChain({
        workload: "ci-fast",
        configuredProvider: "blacksmith-testbox",
        target: "windows",
        advertisedProviders,
      }),
    ).toEqual(["azure", "aws"]);
    expect(
      crabboxProviderChain({
        workload: "ci-fast",
        configuredProvider: "blacksmith-testbox",
        target: "macos",
        advertisedProviders,
      }),
    ).toEqual(["aws"]);
  });

  it("selects the first ready provider without racing providers", () => {
    const readiness = new Map([
      ["blacksmith-testbox", { ready: false, reason: "queued" }],
      ["daytona", { ready: true, reason: "broker-ready" }],
      ["azure", { ready: true, reason: "broker-ready" }],
    ]);

    expect(
      selectReadyCrabboxProvider(["blacksmith-testbox", "daytona", "azure"], readiness),
    ).toEqual({
      provider: "daytona",
      readiness: { ready: true, reason: "broker-ready" },
    });
  });
});
