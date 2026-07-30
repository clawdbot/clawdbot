// Cross-language fixture pins the catalog/admission boundary shared with the Rust node runtime.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeNodeApprovalSurfaceList } from "./node-pairing-surface.js";

type IntegrationFixture = {
  version: number;
  declaredCapabilities: string[];
  expectedCapabilities: string[];
  declaredCommands: string[];
  expectedCommands: string[];
  approvedCommands: string[];
  invocations: Array<{
    command: string;
    expected: "allow" | "deny";
    errorCode?: string;
    errorMessage?: string;
  }>;
};

function loadFixture(): IntegrationFixture {
  const fixturePath = path.join(
    process.cwd(),
    "test",
    "fixtures",
    "node-runtime-integration-contract.json",
  );
  return JSON.parse(fs.readFileSync(fixturePath, "utf8")) as IntegrationFixture;
}

describe("node runtime integration contract", () => {
  it("normalizes the approved catalog and pins admission outcomes", () => {
    const fixture = loadFixture();
    expect(fixture.version).toBe(1);
    expect(normalizeNodeApprovalSurfaceList(fixture.declaredCapabilities).toSorted()).toEqual(
      fixture.expectedCapabilities,
    );
    expect(normalizeNodeApprovalSurfaceList(fixture.declaredCommands).toSorted()).toEqual(
      fixture.expectedCommands,
    );

    const approved = new Set(normalizeNodeApprovalSurfaceList(fixture.approvedCommands));
    for (const invocation of fixture.invocations) {
      expect(approved.has(invocation.command) ? "allow" : "deny").toBe(invocation.expected);
      if (invocation.expected === "deny") {
        expect(invocation.errorCode).toBe("COMMAND_NOT_APPROVED");
        expect(invocation.errorMessage).toBeTruthy();
      }
    }
  });
});
