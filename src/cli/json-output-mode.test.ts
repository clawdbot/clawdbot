// JSON output mode tests cover CLI JSON mode detection and output handling.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loggingState } from "../logging/state.js";
import { hasJsonOutputFlag, withConsoleLogsRoutedToStderrForJson } from "./json-output-mode.js";

describe("json output mode", () => {
  const originalForceStderr = loggingState.forceConsoleToStderr;

  beforeEach(() => {
    loggingState.forceConsoleToStderr = false;
  });

  afterEach(() => {
    loggingState.forceConsoleToStderr = originalForceStderr;
  });

  it("detects json output flags before argv terminators", () => {
    expect(hasJsonOutputFlag(["node", "openclaw", "nodes", "list", "--json"])).toBe(true);
    expect(hasJsonOutputFlag(["node", "openclaw", "nodes", "list", "--json=true"])).toBe(true);
    expect(hasJsonOutputFlag(["node", "openclaw", "nodes", "--", "--json"])).toBe(false);
  });

  it("temporarily routes console logs to stderr while json output is being prepared", async () => {
    const snapshots: boolean[] = [];

    await withConsoleLogsRoutedToStderrForJson(
      ["node", "openclaw", "nodes", "list", "--json"],
      async () => {
        snapshots.push(loggingState.forceConsoleToStderr);
      },
    );

    expect(snapshots).toEqual([true]);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("leaves existing stderr routing enabled after json output preparation", async () => {
    loggingState.forceConsoleToStderr = true;

    await withConsoleLogsRoutedToStderrForJson(
      ["node", "openclaw", "nodes", "list", "--json"],
      async () => {
        expect(loggingState.forceConsoleToStderr).toBe(true);
      },
    );

    expect(loggingState.forceConsoleToStderr).toBe(true);
  });
});
