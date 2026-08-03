import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withOwnedFollowChild } from "./remote-log-tailing-runtime.js";

describe("remote log tailing scenario", () => {
  it("declares packaged CLI, RPC bounds, cursor, follow, and owned SIGINT proof", () => {
    const source = readFileSync(
      path.join(process.cwd(), "test/e2e/qa-lab/runtime/remote-log-tailing-runtime.ts"),
      "utf8",
    );
    expect(source).toContain('"logs.tail"');
    expect(source).toContain("first.cursor");
    expect(source).toContain('"--max-bytes"');
    expect(source).toContain('"--follow"');
    expect(source).toContain("withOwnedFollowChild(child");
    expect(source).toContain('path.join(repoRoot, "dist", "index.js")');
  });

  it("stops and awaits the follow child when the owned operation fails", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await once(child, "spawn");

    await expect(
      withOwnedFollowChild(child, async () => {
        throw new Error("forced follow failure");
      }),
    ).rejects.toThrow("forced follow failure");

    expect(child.signalCode).not.toBeNull();
  });
});
