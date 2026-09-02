// Matrix tests cover isolated runtime state fixtures.
import fs from "node:fs";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, it } from "vitest";
import { getMatrixRuntime } from "./runtime.js";
import { installMatrixTestRuntime } from "./test-runtime.js";

describe("installMatrixTestRuntime", () => {
  it("uses a canonical isolated state directory by default", () => {
    installMatrixTestRuntime();

    const runtime = getMatrixRuntime();
    const stateDir = runtime.state.resolveStateDir(process.env);
    const tempRoot = fs.realpathSync(resolvePreferredOpenClawTmpDir());

    expect(stateDir).toBe(fs.realpathSync(stateDir));
    expect(path.dirname(stateDir)).toBe(tempRoot);
    expect(path.basename(stateDir)).toMatch(/^openclaw-matrix-test-state-/u);

    const store = runtime.state.openSyncKeyedStore<string>({
      namespace: "test-runtime",
      maxEntries: 1,
    });
    store.register("state", "isolated");
    expect(store.lookup("state")).toBe("isolated");
  });

  it("preserves an explicit state directory override", () => {
    const stateDir = path.join(resolvePreferredOpenClawTmpDir(), "matrix-explicit-state");
    installMatrixTestRuntime({ stateDir });

    expect(getMatrixRuntime().state.resolveStateDir(process.env)).toBe(stateDir);
  });
});
