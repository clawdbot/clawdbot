import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const mocks = vi.hoisted(() => ({
  preflightClawPackage: vi.fn(),
}));

vi.mock("../claws/packages.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/packages.js")>("../claws/packages.js")),
  preflightClawPackage: mocks.preflightClawPackage,
}));

const { runClawsInspectCommand } = await import("./claws-cli.runtime.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("claws inspect extensions", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    mocks.preflightClawPackage.mockReset();
  });

  it("reports canonical profile extension mappings", async () => {
    const root = tempDirs.make("openclaw-claws-inspect-extension-");
    await mkdir(join(root, "profiles"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@acme/demo-agent",
        version: "1.2.3",
        openclaw: { claw: "openclaw.claw.json" },
      }),
      "utf8",
    );
    await writeFile(
      join(root, "openclaw.claw.json"),
      JSON.stringify({ schemaVersion: 1, agent: { id: "demo-agent" } }),
      "utf8",
    );
    await writeFile(
      join(root, "profiles", "openclaw.yml"),
      [
        "schemaVersion: 1",
        "agent: {}",
        "extensions:",
        "  - id: audit-tools",
        "    kind: plugin",
        "    format: claude",
        "    source: clawhub",
        "    ref: '@owner/audit'",
        "    version: 2.0.1",
        "",
      ].join("\n"),
      "utf8",
    );
    mocks.preflightClawPackage.mockResolvedValue({
      ok: true,
      action: "install",
      integrity: `sha256:${"a".repeat(64)}`,
      installId: "audit",
      detectedFormat: "claude",
      mapped: ["commands", "skills"],
      unavailable: ["agents"],
      adapterIdentity: "openclaw/test",
    });
    const values: unknown[] = [];
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      writeJson: vi.fn((value: unknown) => values.push(value)),
      writeStdout: vi.fn(),
      exit: vi.fn(),
    };

    await runClawsInspectCommand(root, { json: true }, runtime);

    expect(values[0]).toMatchObject({
      valid: true,
      extensions: [
        {
          id: "audit-tools",
          detectedFormat: "claude",
          mapped: ["commands", "skills"],
          unavailable: ["agents"],
          adapterIdentity: "openclaw/test",
        },
      ],
    });
    expect(mocks.preflightClawPackage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "plugin", ref: "@owner/audit" }),
      root,
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("rejects a plugin declared by both the portable manifest and OpenClaw profile", async () => {
    const root = tempDirs.make("openclaw-claws-inspect-extension-collision-");
    await mkdir(join(root, "profiles"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@acme/demo-agent",
        version: "1.2.3",
        openclaw: { claw: "openclaw.claw.json" },
      }),
      "utf8",
    );
    await writeFile(
      join(root, "openclaw.claw.json"),
      JSON.stringify({
        schemaVersion: 1,
        agent: { id: "demo-agent" },
        packages: [
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/audit",
            version: "2.0.1",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      join(root, "profiles", "openclaw.yml"),
      [
        "schemaVersion: 1",
        "agent: {}",
        "extensions:",
        "  - id: audit-tools",
        "    kind: plugin",
        "    format: openclaw",
        "    source: clawhub",
        "    ref: '@owner/audit'",
        "    version: 2.0.1",
        "",
      ].join("\n"),
      "utf8",
    );
    mocks.preflightClawPackage.mockResolvedValue({
      ok: true,
      action: "install",
      integrity: `sha256:${"a".repeat(64)}`,
      installId: "audit",
      detectedFormat: "openclaw",
      mapped: ["skills"],
      unavailable: [],
      adapterIdentity: "openclaw/test",
    });
    const values: unknown[] = [];
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      writeJson: vi.fn((value: unknown) => values.push(value)),
      writeStdout: vi.fn(),
      exit: vi.fn(),
    };

    await runClawsInspectCommand(root, { json: true }, runtime);

    expect(values[0]).toMatchObject({
      valid: false,
      diagnostics: [expect.objectContaining({ code: "extension_package_collision" })],
    });
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
