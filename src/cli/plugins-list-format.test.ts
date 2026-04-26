import { describe, expect, it } from "vitest";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { formatPluginLine } from "./plugins-list-format.js";

describe("formatPluginLine", () => {
  it("labels active registry entries as enabled rather than loaded", () => {
    const output = formatPluginLine(createPluginRecord({ id: "demo", enabled: true }));

    expect(output).toContain("enabled");
    expect(output).not.toContain("loaded");
  });

  it("shows imported state in verbose output", () => {
    const output = formatPluginLine(
      createPluginRecord({
        id: "demo",
        name: "Demo Plugin",
        imported: false,
        activated: true,
        explicitlyEnabled: false,
      }),
      true,
    );

    expect(output).toContain("activated: yes");
    expect(output).toContain("imported: no");
    expect(output).toContain("explicitly enabled: no");
  });

  it("sanitizes activation reasons in verbose output", () => {
    const output = formatPluginLine(
      createPluginRecord({
        id: "demo",
        name: "Demo Plugin",
        activated: true,
        activationSource: "auto",
        activationReason: "\u001B[31mconfigured\nnext\tstep",
      }),
      true,
    );

    expect(output).toContain("activation reason: configured\\nnext\\tstep");
    expect(output).not.toContain("\u001B[31m");
    expect(output.match(/activation reason:/g)).toHaveLength(1);
  });
});
