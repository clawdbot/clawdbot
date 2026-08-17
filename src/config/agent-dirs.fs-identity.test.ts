import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { findDuplicateAgentDirs } from "./agent-dirs.js";

describe("agent directory filesystem identity", () => {
  it("keeps case-distinct directories separate on a case-sensitive volume", async () => {
    await withTestDir({ prefix: "openclaw-agent-dirs-case-" }, async (root) => {
      const upper = path.join(root, "AgentState");
      const lower = path.join(root, "agentstate");
      await fs.mkdir(upper);
      try {
        await fs.mkdir(lower);
      } catch {
        return;
      }

      expect(
        findDuplicateAgentDirs({
          agents: {
            list: [
              { id: "upper", agentDir: upper },
              { id: "lower", agentDir: lower },
            ],
          },
        }),
      ).toHaveLength(0);
    });
  });

  it("rejects aliases that resolve to the same directory", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTestDir({ prefix: "openclaw-agent-dirs-alias-" }, async (root) => {
      const target = path.join(root, "target");
      const alias = path.join(root, "alias");
      await fs.mkdir(target);
      await fs.symlink(target, alias);

      expect(
        findDuplicateAgentDirs({
          agents: {
            list: [
              { id: "target", agentDir: target },
              { id: "alias", agentDir: alias },
            ],
          },
        }),
      ).toEqual([{ agentDir: target, agentIds: ["target", "alias"] }]);
    });
  });

  it("does not create configured missing directories or leave probe entries", async () => {
    await withTestDir({ prefix: "openclaw-agent-dirs-missing-" }, async (root) => {
      const upper = path.join(root, "FutureState");
      const lower = path.join(root, "futurestate");

      findDuplicateAgentDirs({
        agents: {
          list: [
            { id: "upper", agentDir: upper },
            { id: "lower", agentDir: lower },
          ],
        },
      });

      await expect(fs.stat(upper)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(lower)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(root)).resolves.toEqual([]);
    });
  });
});
