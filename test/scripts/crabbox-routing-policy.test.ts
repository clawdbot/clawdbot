import { describe, expect, it } from "vitest";
import {
  crabboxProviderChain,
  normalizeCrabboxWorkload,
  selectReadyCrabboxProvider,
} from "../../scripts/crabbox-routing-policy.mjs";

const advertisedProviders = ["aws", "azure", "blacksmith-testbox", "daytona"];

describe("Crabbox routing policy", () => {
  it("normalizes supported workload aliases", () => {
    expect(normalizeCrabboxWorkload("check")).toBe("ci-fast");
    expect(normalizeCrabboxWorkload("release")).toBe("release-proof");
    expect(normalizeCrabboxWorkload("unknown")).toBeNull();
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
