import { describe, expect, it } from "vitest";
import {
  readClawHubIdentity,
  renderClawHubMaterializerPins,
} from "../../scripts/sync-clawhub-cli-pins.mts";

describe("ClawHub CLI pin synchronization", () => {
  it("reads the exact identity from the trusted package graph", () => {
    const identity = readClawHubIdentity(process.cwd());

    expect(identity.version).toMatch(/^\d+\.\d+\.\d+/u);
    expect(identity.integrity).toMatch(/^sha512-/u);
    expect(identity.lockSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("updates all materializer identity pins together", () => {
    const rendered = renderClawHubMaterializerPins(
      [
        'expected_lock_sha256="old-lock"',
        'expected_clawhub_integrity="sha512-old"',
        '[[ "${clawhub_version}" == "0.0.0" ]] || {',
      ].join("\n"),
      {
        integrity: "sha512-new",
        lockSha256: "new-lock",
        version: "1.2.3",
      },
    );

    expect(rendered).toContain('expected_lock_sha256="new-lock"');
    expect(rendered).toContain('expected_clawhub_integrity="sha512-new"');
    expect(rendered).toContain('[[ "${clawhub_version}" == "1.2.3" ]]');
  });
});
