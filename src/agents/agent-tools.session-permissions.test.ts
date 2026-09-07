import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { expectReadWriteEditTools, getTextContent } from "./test-helpers/agent-tools-fs-helpers.js";

vi.mock("../infra/shell-env.js", async () => {
  const mod =
    await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js");
  return { ...mod, getShellPathFromLoginShell: () => null };
});

const fileToolCases = [
  {
    name: "write",
    initial: undefined,
    expected: "changed\n",
    args: (target: string) => ({ path: target, content: "changed\n" }),
  },
  {
    name: "read",
    initial: "original\n",
    expected: "original\n",
    args: (target: string) => ({ path: target }),
  },
  {
    name: "edit",
    initial: "original\n",
    expected: "changed\n",
    args: (target: string) => ({
      path: target,
      edits: [{ oldText: "original", newText: "changed" }],
    }),
  },
  {
    name: "apply_patch",
    initial: "original\n",
    expected: "changed\n",
    args: (target: string) => ({
      input: `*** Begin Patch\n*** Update File: ${target}\n@@\n-original\n+changed\n*** End Patch`,
    }),
  },
];

async function withAliasedWorkspace(
  run: (paths: { parent: string; root: string; alias: string }) => Promise<void>,
) {
  await withTempDir("openclaw-permission-alias-", async (dir) => {
    const parent = await fs.realpath(dir);
    const root = path.join(parent, "workspace");
    const alias = path.join(parent, "workspace-alias");
    await fs.mkdir(path.join(root, "packages", "app"), { recursive: true });
    await fs.symlink(root, alias, "dir");
    await expect(fs.realpath(alias)).resolves.toBe(root);
    await run({ parent, root, alias });
  });
}

describe("session permission filesystem tools", () => {
  describe.runIf(process.platform !== "win32")(
    "guarded canonical root with alias workspace",
    () => {
      describe.each([
        { name: "relative path", cwdSuffix: "", absolute: false },
        { name: "absolute alias path", cwdSuffix: "", absolute: true },
        { name: "relative path from nested cwd", cwdSuffix: "packages/app", absolute: false },
        { name: "absolute alias path from nested cwd", cwdSuffix: "packages/app", absolute: true },
      ])("$name", ({ cwdSuffix, absolute }) => {
        it.each(fileToolCases)("allows $name within the same directory", async (testCase) => {
          await withAliasedWorkspace(async ({ root, alias }) => {
            const cwd = path.join(alias, cwdSuffix);
            const tools = createOpenClawCodingTools({
              workspaceDir: alias,
              cwd,
              sessionPermissionPolicy: { root, mode: "guarded" },
            });
            const tool = tools.find((entry) => entry.name === testCase.name);
            if (!tool) {
              throw new Error(`expected ${testCase.name} tool`);
            }
            const target = absolute
              ? path.join(alias, "proof.txt")
              : path.relative(cwd, path.join(alias, "proof.txt"));
            // The canonical spelling is a control for the same tool and arguments;
            // only the workspace alias should distinguish the regression call.
            for (const input of [path.join(root, "control.txt"), target]) {
              const canonicalTarget = path.join(
                root,
                input === target ? "proof.txt" : "control.txt",
              );
              if (testCase.initial !== undefined) {
                await fs.writeFile(canonicalTarget, testCase.initial, "utf8");
              }
              const result = await tool.execute(`alias-${testCase.name}`, testCase.args(input));
              if (testCase.name === "read") {
                expect(getTextContent(result)).toContain(testCase.expected);
              }
              await expect(fs.readFile(canonicalTarget, "utf8")).resolves.toBe(testCase.expected);
            }
          });
        });
      });

      it.each(["relative", "absolute"])("allows %s alias reads in read-only mode", async (form) => {
        await withAliasedWorkspace(async ({ root, alias }) => {
          await fs.writeFile(path.join(root, "proof.txt"), "original\n", "utf8");
          const tools = createOpenClawCodingTools({
            workspaceDir: alias,
            cwd: alias,
            sessionPermissionPolicy: { root, mode: "read-only" },
          });
          const names = tools.map((tool) => tool.name);
          for (const name of ["write", "edit", "apply_patch"]) {
            expect(names).not.toContain(name);
          }
          const readTool = tools.find((tool) => tool.name === "read");
          if (!readTool) {
            throw new Error("expected read tool");
          }
          const target = form === "relative" ? "proof.txt" : path.join(alias, "proof.txt");
          expect(getTextContent(await readTool.execute("alias-read-only", { path: target }))).toBe(
            "original\n",
          );
        });
      });

      it("denies unrelated external aliases pointing into the root", async () => {
        await withAliasedWorkspace(async ({ parent, root, alias }) => {
          const inside = path.join(root, "proof.txt");
          await fs.writeFile(inside, "original\n", "utf8");
          const tools = createOpenClawCodingTools({
            workspaceDir: alias,
            cwd: alias,
            sessionPermissionPolicy: { root, mode: "guarded" },
          });
          for (const untrusted of [path.join(parent, "external-alias"), `${alias}-untrusted`]) {
            await fs.symlink(root, untrusted, "dir");
            const target = path.join(untrusted, "proof.txt");
            await expect(fs.realpath(target)).resolves.toBe(inside);
            for (const testCase of fileToolCases) {
              const tool = tools.find((entry) => entry.name === testCase.name);
              if (!tool) {
                throw new Error(`expected ${testCase.name} tool`);
              }
              await expect(
                tool.execute(`inward-${testCase.name}`, testCase.args(target)),
              ).rejects.toThrow(/escapes sandbox root/i);
              await expect(fs.readFile(inside, "utf8")).resolves.toBe("original\n");
            }
          }
        });
      });

      it.each([false, true])(
        "keeps missing daily memory optional with alias=%s",
        async (aliased) => {
          await withAliasedWorkspace(async ({ root, alias }) => {
            const tools = createOpenClawCodingTools({
              workspaceDir: aliased ? alias : root,
              sessionPermissionPolicy: { root, mode: "guarded" },
            });
            const { readTool } = expectReadWriteEditTools(tools);
            const result = await readTool.execute("missing-daily-memory", {
              path: "memory/2026-08-27.md",
            });
            expect(result.details).toMatchObject({ kind: "not_found", optional: true });
          });
        },
      );

      it("retains patch creation parent checks through trusted aliases", async () => {
        await withAliasedWorkspace(async ({ root, alias }) => {
          await fs.mkdir(path.join(root, "real"));
          await fs.symlink(path.join(root, "real"), path.join(root, "link"), "dir");
          const tools = createOpenClawCodingTools({
            workspaceDir: alias,
            cwd: alias,
            sessionPermissionPolicy: { root, mode: "guarded" },
          });
          const patch = tools.find((tool) => tool.name === "apply_patch");
          if (!patch) {
            throw new Error("expected apply_patch tool");
          }
          for (const target of [
            path.join(root, "link/new.txt"),
            path.join(alias, "link/new.txt"),
          ]) {
            await expect(
              patch.execute("alias-patch-parent", {
                input: `*** Begin Patch\n*** Add File: ${target}\n+created\n*** End Patch`,
              }),
            ).rejects.toThrow(/Path alias under sandbox root/i);
          }
          await expect(fs.readdir(path.join(root, "real"))).resolves.toEqual([]);
          await patch.execute("alias-patch-create", {
            input: `*** Begin Patch\n*** Add File: ${alias}/new/proof.txt\n+created\n*** End Patch`,
          });
          await expect(fs.readFile(path.join(root, "new", "proof.txt"), "utf8")).resolves.toBe(
            "created\n",
          );
        });
      });

      it.each(["outside path", "symlink target", "raw symlink/.. traversal"])(
        "denies %s without changing either target",
        async (escapeKind) => {
          await withAliasedWorkspace(async ({ parent, root, alias }) => {
            const outsideDir = path.join(parent, "outside");
            const outside = path.join(outsideDir, "proof.txt");
            const decoy = path.join(root, "sub", "outside", "proof.txt");
            await fs.mkdir(outsideDir);
            await fs.mkdir(path.dirname(decoy), { recursive: true });
            await fs.writeFile(outside, "original\n", "utf8");
            await fs.writeFile(decoy, "original\n", "utf8");
            await fs.symlink(outside, path.join(root, "escape.txt"));
            await fs.symlink("..", path.join(root, "sub", "up"), "dir");
            // Native traversal leaves the root, although lexical normalization
            // points at the in-root decoy. Keep the raw '..' bytes in tool input.
            const relativeEscape =
              escapeKind === "outside path"
                ? "../outside/proof.txt"
                : escapeKind === "symlink target"
                  ? "escape.txt"
                  : "sub/up/../outside/proof.txt";
            const canonicalInput = `${root}/${relativeEscape}`;
            await expect(fs.readFile(canonicalInput, "utf8")).resolves.toBe("original\n");
            await expect(fs.realpath(canonicalInput)).resolves.toBe(outside);
            const tools = createOpenClawCodingTools({
              workspaceDir: alias,
              cwd: alias,
              sessionPermissionPolicy: { root, mode: "guarded" },
            });
            for (const testCase of fileToolCases) {
              const tool = tools.find((entry) => entry.name === testCase.name);
              if (!tool) {
                throw new Error(`expected ${testCase.name} tool`);
              }
              for (const input of [canonicalInput, relativeEscape]) {
                await expect(
                  tool.execute(`escape-${testCase.name}`, testCase.args(input)),
                ).rejects.toThrow(/(?:escapes|outside) sandbox root/i);
                await expect(fs.readFile(outside, "utf8")).resolves.toBe("original\n");
                await expect(fs.readFile(decoy, "utf8")).resolves.toBe("original\n");
              }
            }
            await expect(fs.readlink(path.join(root, "escape.txt"))).resolves.toBe(outside);
          });
        },
      );
    },
  );

  it.each(["guarded", "workspace"] as const)(
    "separates a nested session cwd from its %s permission boundary",
    async (mode) => {
      await withTempDir("openclaw-permission-root-", async (root) => {
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
          await expect(fs.readFile(path.join(root, "shared.txt"), "utf8")).resolves.toBe("patched");
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
    await withTempDir("openclaw-permission-read-only-", async (root) => {
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

  it("denies exec when a turn tightens the dispatch-provided full mode", async () => {
    await withTempDir("openclaw-permission-exec-", async (root) => {
      const tools = createOpenClawCodingTools({
        workspaceDir: root,
        sessionPermissionPolicy: { root, mode: "full" },
        exec: { host: "gateway", mode: "full", security: "deny", ask: "off" },
      });
      const exec = tools.find((tool) => tool.name === "exec");
      if (!exec) {
        throw new Error("expected exec tool");
      }
      await expect(
        exec.execute("tightened-exec", { command: "echo exec-policy-proof" }),
      ).rejects.toThrow(/security=deny/);
    });
  });

  describe.each([undefined, true] as const)("full mode with required root=%s", (required) => {
    it("lists directories without granting access beyond a required root", async () => {
      await withTempDir("openclaw-listing-root-", async (parent) => {
        const root = path.join(await fs.realpath(parent), "workspace");
        const outside = path.join(await fs.realpath(parent), "other-agent");
        await fs.mkdir(path.join(root, "nested"), { recursive: true });
        await fs.mkdir(outside);
        await fs.writeFile(path.join(outside, "private.txt"), "private");
        const ls = createOpenClawCodingTools({
          workspaceDir: root,
          requireWorkspaceOnly: required,
          sessionPermissionPolicy: { root, mode: "full" },
        }).find((tool) => tool.name === "ls");
        if (!ls) {
          throw new Error("Expected directory discovery tool.");
        }
        expect(getTextContent(await ls.execute("inside", { path: "." }))).toBe('"nested/"');
        if (required) {
          await expect(ls.execute("outside", { path: outside })).rejects.toThrow(/sandbox root/i);
        } else {
          expect(getTextContent(await ls.execute("outside", { path: outside }))).toBe(
            '"private.txt"',
          );
        }
      });
    });

    it.each(fileToolCases)("preserves $name authority and final file effects", async (testCase) => {
      await withTempDir("openclaw-permission-full-", async (parent) => {
        const root = path.join(await fs.realpath(parent), "workshop");
        const inside = path.join(root, "proof.txt");
        const outside = path.join(parent, "other-agent.txt");
        await fs.mkdir(root);
        await fs.writeFile(outside, "original\n");
        if (testCase.initial !== undefined) {
          await fs.writeFile(inside, testCase.initial);
        }
        const tool = createOpenClawCodingTools({
          workspaceDir: root,
          requireWorkspaceOnly: required,
          sessionPermissionPolicy: { root, mode: "full" },
        }).find((entry) => entry.name === testCase.name);
        if (!tool) {
          throw new Error(`expected ${testCase.name} tool`);
        }
        const result = await tool.execute("inside", testCase.args(inside));
        if (testCase.name === "read") {
          expect(getTextContent(result)).toContain(testCase.expected);
        }
        await expect(fs.readFile(inside, "utf8")).resolves.toBe(testCase.expected);
        if (required) {
          await expect(tool.execute("outside", testCase.args(outside))).rejects.toThrow(
            /sandbox root/i,
          );
          await expect(fs.readFile(outside, "utf8")).resolves.toBe("original\n");
        } else {
          const outsideResult = await tool.execute("outside", testCase.args(outside));
          if (testCase.name === "read") {
            expect(getTextContent(outsideResult)).toContain(testCase.expected);
          }
          await expect(fs.readFile(outside, "utf8")).resolves.toBe(testCase.expected);
        }
      });
    });
  });
});
