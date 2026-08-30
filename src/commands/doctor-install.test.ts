// Doctor install tests cover install checks, repair notes, and binary/package diagnostics.
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { noteSourceInstallIssues } from "./doctor-install.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: vi.fn(),
}));

async function writeFile(root: string, relativePath: string, content = "") {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

describe("noteSourceInstallIssues", () => {
  beforeEach(() => {
    vi.mocked(note).mockReset();
  });

  it("does not treat a packaged workspace config as a source checkout", async () => {
    await withTempDir("openclaw-doctor-install-", async (root) => {
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
      await writeFile(root, "pnpm-workspace.yaml", "packages:\n  - .\n");

      noteSourceInstallIssues(root);

      expect(note).not.toHaveBeenCalled();
    });
  });

  it("warns source checkouts when node_modules was not installed by pnpm", async () => {
    await withTempDir("openclaw-doctor-install-", async (root) => {
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
      await writeFile(root, "pnpm-workspace.yaml", "packages:\n  - .\n");
      await writeFile(root, "src/entry.ts", "export {};\n");

      noteSourceInstallIssues(root);

      expect(note).toHaveBeenCalledWith(
        [
          "- node_modules was not installed by pnpm (missing node_modules/.pnpm). Run: pnpm install so bundled plugins can load package-local dependencies.",
          "- tsx binary is missing for source runs. Run: pnpm install.",
        ].join("\n"),
        "Install",
      );
    });
  });

  it("warns when package.json gained a self-referential openclaw link dependency", async () => {
    await withTempDir("openclaw-doctor-install-", async (root) => {
      await writeFile(root, "pnpm-workspace.yaml", "packages:\n  - .\n");
      await writeFile(root, "src/entry.ts", "export {};\n");
      await writeFile(
        root,
        "package.json",
        JSON.stringify({ name: "openclaw", dependencies: { openclaw: "link:" } }),
      );

      noteSourceInstallIssues(root);

      const output = vi
        .mocked(note)
        .mock.calls.map(([message]) => String(message))
        .join("\n");
      expect(output).toContain('self-referential "openclaw": "link:" dependency');
      expect(output).toContain("Inspect the diff: git diff package.json pnpm-workspace.yaml");
    });
  });

  it("warns when pnpm-workspace.yaml gained a self-referential openclaw link entry", async () => {
    await withTempDir("openclaw-doctor-install-", async (root) => {
      await writeFile(
        root,
        "pnpm-workspace.yaml",
        "packages:\n  - .\noverrides:\n  openclaw: link:\n",
      );
      await writeFile(root, "src/entry.ts", "export {};\n");
      await writeFile(root, "package.json", JSON.stringify({ name: "openclaw" }));

      noteSourceInstallIssues(root);

      const output = vi
        .mocked(note)
        .mock.calls.map(([message]) => String(message))
        .join("\n");
      expect(output).toContain('self-referential "openclaw: link:" entry');
      expect(output).toContain("Inspect the diff: git diff package.json pnpm-workspace.yaml");
    });
  });

  it("warns when pnpm-workspace.yaml uses quoted link: value", async () => {
    await withTempDir("openclaw-doctor-install-", async (root) => {
      await writeFile(
        root,
        "pnpm-workspace.yaml",
        "packages:\n  - .\noverrides:\n  openclaw: 'link:'\n",
      );
      await writeFile(root, "src/entry.ts", "export {};\n");
      await writeFile(root, "package.json", JSON.stringify({ name: "openclaw" }));

      noteSourceInstallIssues(root);

      const output = vi
        .mocked(note)
        .mock.calls.map(([message]) => String(message))
        .join("\n");
      expect(output).toContain('self-referential "openclaw: link:" entry');
    });
  });

  it("stays silent for a healthy source checkout without self-links", async () => {
    await withTempDir("openclaw-doctor-install-", async (root) => {
      await fs.mkdir(path.join(root, "node_modules", ".pnpm"), { recursive: true });
      await writeFile(root, "node_modules/.bin/tsx", "#!/bin/sh\n");
      await writeFile(root, "pnpm-workspace.yaml", "packages:\n  - .\n");
      await writeFile(root, "src/entry.ts", "export {};\n");
      await writeFile(
        root,
        "package.json",
        JSON.stringify({ name: "openclaw", dependencies: { react: "^19.0.0" } }),
      );

      noteSourceInstallIssues(root);

      expect(note).not.toHaveBeenCalled();
    });
  });
});
