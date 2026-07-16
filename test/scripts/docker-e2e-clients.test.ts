// Docker E2E client tests cover packaged-dist harness wiring.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readScript(pathname: string): string {
  return readFileSync(pathname, "utf8");
}

describe("Docker E2E client scripts", () => {
  it("keeps commitments safety checks wired to packaged commitment runtime", () => {
    const source = readScript("scripts/e2e/commitments-safety-docker-client.ts");

    expect(source).toContain("../../dist/commitments/runtime.js");
    expect(source).toContain("../../dist/commitments/runtime.test-support.js");
    expect(source).toContain("../../dist/commitments/store.js");
    expect(source).toContain("verifyQueueCap()");
    expect(source).toContain("verifyExtractionStoresTypedMetadataOnly()");
    expect(source).toContain("verifyDoctorImportAndRuntimeIsolation()");
    expect(source).toContain("verifyExpiryTransition()");
    expect(source).toContain('[entry, "doctor", "--fix", "--yes", "--force"]');
    expect(source).toContain("CALL_TOOL");
  });

  it("keeps session runtime-context checks wired to packaged transcript behavior", () => {
    const source = readScript("scripts/e2e/session-runtime-context-docker-client.ts");

    expect(source).toContain("openclaw/plugin-sdk/agent-sessions");
    expect(source).toContain(
      "../../dist/agents/embedded-agent-runner/run/runtime-context-prompt.js",
    );
    expect(source).toContain("verifyRuntimeContextTranscriptShape(root)");
    expect(source).toContain("verifyDoctorRepair(root)");
    expect(source).toContain("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>");
    expect(source).toContain("openclaw.runtime-context");
    expect(source).toContain("doctor repair left runtime context in active transcript");
  });
});
