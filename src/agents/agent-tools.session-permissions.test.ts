import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-utils/temp-dir.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { expectReadWriteEditTools, getTextContent } from "./test-helpers/agent-tools-fs-helpers.js";

vi.mock("../infra/shell-env.js", async () => {
  const mod =
    await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js");
  return { ...mod, getShellPathFromLoginShell: () => null };
});

describe("session permission filesystem tools", () => {
  it.each(["guarded", "workspace"] as const)(
    "separates a nested session cwd from its %s permission boundary",
    async (mode) => {
      await withTestDir("openclaw-permission-root-", async (root) => {
        const cwd = path.join(root, "packages", "app");
        const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.txt`);
        const escape = path.join(root, "escape.txt");
        await fs.mkdir(cwd, { recursive: true });
        await fs.writeFile(path.join(root, "shared.txt"), "shared", "utf8");
        await fs.writeFile(outside, "outside", "utf8");
        if (process.platform !== "win32") {
          await fs.symlink(outside, escape);
        }
        try {
          const tools = createOpenClawCodingTools({
            workspaceDir: root,
            cwd,
            sessionPermissionPolicy: { root, mode },
          });
          const { readTool, writeTool } = expectReadWriteEditTools(tools);

          expect(
            getTextContent(await readTool.execute("nested-read", { path: "../../shared.txt" })),
          ).toContain("shared");
          await writeTool.execute("nested-write", {
            path: "../../created.txt",
            content: "created",
          });
          await expect(fs.readFile(path.join(root, "created.txt"), "utf8")).resolves.toBe(
            "created",
          );
          const applyPatch = tools.find((tool) => tool.name === "apply_patch");
          if (!applyPatch) {
            throw new Error("expected apply_patch tool");
          }
          await applyPatch.execute("nested-patch", {
            input:
              "*** Begin Patch\n*** Update File: ../../shared.txt\n@@\n-shared\n+patched\n*** End Patch",
          });
          await expect(fs.readFile(path.join(root, "shared.txt"), "utf8")).resolves.toBe(
            "patched\n",
          );
          await expect(readTool.execute("outside-read", { path: outside })).rejects.toThrow(
            /sandbox root/i,
          );
          if (process.platform !== "win32") {
            await expect(readTool.execute("symlink-read", { path: escape })).rejects.toThrow(
              /symlink|sandbox|outside|escape/i,
            );
          }
        } finally {
          await fs.rm(outside, { force: true });
        }
      });
    },
  );

  it("removes mutating filesystem tools in read-only mode", async () => {
    await withTestDir("openclaw-permission-read-only-", async (root) => {
      const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.txt`);
      await fs.writeFile(path.join(root, "inside.txt"), "inside", "utf8");
      await fs.writeFile(outside, "outside", "utf8");
      try {
        const tools = createOpenClawCodingTools({
          workspaceDir: root,
          sessionPermissionPolicy: { root, mode: "read-only" },
        });
        const names = tools.map((tool) => tool.name);
        expect(names).toContain("read");
        expect(names).toContain("exec");
        expect(names).not.toContain("write");
        expect(names).not.toContain("edit");
        expect(names).not.toContain("apply_patch");
        const readTool = tools.find((tool) => tool.name === "read");
        if (!readTool) {
          throw new Error("expected read tool");
        }
        expect(
          getTextContent(await readTool.execute("read-only-inside", { path: "inside.txt" })),
        ).toContain("inside");
        await expect(readTool.execute("read-only-outside", { path: outside })).rejects.toThrow(
          /sandbox root/i,
        );
      } finally {
        await fs.rm(outside, { force: true });
      }
    });
  });

  it("keeps full mode filesystem access unrestricted", async () => {
    await withTestDir("openclaw-permission-full-", async (root) => {
      const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.txt`);
      await fs.writeFile(outside, "outside", "utf8");
      try {
        const tools = createOpenClawCodingTools({
          workspaceDir: root,
          sessionPermissionPolicy: { root, mode: "full" },
        });
        const { readTool, writeTool } = expectReadWriteEditTools(tools);
        expect(getTextContent(await readTool.execute("full-read", { path: outside }))).toContain(
          "outside",
        );
        await writeTool.execute("full-write", { path: outside, content: "changed" });
        await expect(fs.readFile(outside, "utf8")).resolves.toBe("changed");
      } finally {
        await fs.rm(outside, { force: true });
      }
    });
  });
});
