import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existingPaths: new Set<string>(),
  packageRoot: "/openclaw-package",
}));

vi.mock("node:fs", () => ({
  existsSync: (candidate: string) => mocks.existingPaths.has(candidate),
}));

vi.mock("../../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync: () => mocks.packageRoot,
}));

import { buildNativeHookRelayCommand } from "./native-hook-relay-command.js";
import { shellQuoteArgs } from "./native-hook-relay-utils.js";

function buildCommand(): string {
  return buildNativeHookRelayCommand({
    provider: "codex",
    relayId: "relay-1",
    event: "post_tool_use",
  });
}

describe("native hook relay executable resolution", () => {
  beforeEach(() => {
    mocks.existingPaths.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers the isolated packaged relay over the general CLI", () => {
    const relayEntry = path.join(mocks.packageRoot, "dist", "native-hook-relay", "entry.js");
    const generalCli = path.join(mocks.packageRoot, "openclaw.mjs");
    mocks.existingPaths.add(relayEntry);
    mocks.existingPaths.add(generalCli);

    expect(buildCommand()).toContain(`${shellQuoteArgs([relayEntry])} hooks relay`);
  });

  it("falls back to the packaged general CLI when the isolated artifact is absent", () => {
    const generalCli = path.join(mocks.packageRoot, "openclaw.mjs");
    mocks.existingPaths.add(generalCli);

    expect(buildCommand()).toContain(`${shellQuoteArgs([generalCli])} hooks relay`);
  });

  it("preserves the explicit CLI path override", () => {
    const override = path.resolve("/custom/openclaw-entry.mjs");
    vi.stubEnv("OPENCLAW_CLI_PATH", override);
    mocks.existingPaths.add(override);
    mocks.existingPaths.add(path.join(mocks.packageRoot, "dist", "native-hook-relay", "entry.js"));

    expect(buildCommand()).toContain(`${shellQuoteArgs([override])} hooks relay`);
  });
});
