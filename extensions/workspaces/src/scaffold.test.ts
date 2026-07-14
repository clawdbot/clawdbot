import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scaffoldWorkspaceWidget } from "./scaffold.js";

const stateDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    stateDirs.splice(0).map((stateDir) => fs.rm(stateDir, { recursive: true, force: true })),
  );
});

describe("scaffoldWorkspaceWidget", () => {
  it("escapes apostrophes in generated HTML text nodes", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-scaffold-"));
    stateDirs.push(stateDir);

    const result = await scaffoldWorkspaceWidget({
      name: "team-status",
      title: "Team's <status>",
      createdBy: "agent's helper",
      stateDir,
    });
    const html = await fs.readFile(path.join(result.dir, "index.html"), "utf8");

    expect(html).toContain("<title>Team&#39;s &lt;status&gt;</title>");
    expect(html).toContain("<h1>Team&#39;s &lt;status&gt;</h1>");
    expect(html).toContain("<footer>Built by agent&#39;s helper</footer>");
  });
});
