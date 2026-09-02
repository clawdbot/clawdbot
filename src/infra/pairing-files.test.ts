// Covers shared pairing file helpers.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pruneExpiredPending, resolvePairingPaths } from "./pairing-files.js";

describe("pairing file helpers", () => {
  it("resolves pairing file paths from explicit base dirs", () => {
    expect(resolvePairingPaths("/tmp/openclaw-state", "devices")).toEqual({
      dir: path.join("/tmp/openclaw-state", "devices"),
      pendingPath: path.join("/tmp/openclaw-state", "devices", "pending.json"),
      pairedPath: path.join("/tmp/openclaw-state", "devices", "paired.json"),
    });
  });

  it("prunes only entries older than the ttl", () => {
    const pendingById = {
      stale: { ts: 10, requestId: "stale" },
      edge: { ts: 50, requestId: "edge" },
      fresh: { ts: 70, requestId: "fresh" },
    };

    pruneExpiredPending(pendingById, 100, 50);

    expect(pendingById).toEqual({
      edge: { ts: 50, requestId: "edge" },
      fresh: { ts: 70, requestId: "fresh" },
    });
  });
});
