/**
 * Regression coverage for IDENTITY.md parsing and merging.
 * Ensures placeholders are ignored and rich identity fields stay stable.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadAgentIdentityFromFile,
  loadAgentIdentityFromWorkspace,
  mergeIdentityMarkdownContent,
} from "./identity-file.js";

const TEST_MAX_IDENTITY_FILE_BYTES = 4 * 1024 * 1024;

async function parseIdentityFromContent(
  content: string,
): Promise<import("./identity-file.js").AgentIdentityFile | null> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-identity-parse-"));
  const filePath = path.join(tempDir, "IDENTITY.md");
  fs.writeFileSync(filePath, content, "utf-8");
  try {
    return await loadAgentIdentityFromFile(filePath);
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}

describe("parseIdentityMarkdown", () => {
  it("ignores identity template placeholders", async () => {
    const content = `
# IDENTITY.md - Who Am I?

- **Name:** *(pick something you like)*
- **Creature:** *(AI? robot? familiar? ghost in the machine? something weirder?)*
- **Vibe:** *(how do you come across? sharp? warm? chaotic? calm?)*
- **Emoji:** *(your signature - pick one that feels right)*
- **Avatar:** *(workspace-relative path, http(s) URL, or data URI)*
    `;
    const parsed = await parseIdentityFromContent(content);
    expect(parsed).toBeNull();
  });

  it("parses explicit identity values", async () => {
    const content = `
- **Name:** Samantha
- **Creature:** Robot
- **Vibe:** Warm
- **Emoji:** :robot:
- **Avatar:** avatars/openclaw.png
`;
    const parsed = await parseIdentityFromContent(content);
    expect(parsed).toEqual({
      name: "Samantha",
      creature: "Robot",
      vibe: "Warm",
      emoji: ":robot:",
      avatar: "avatars/openclaw.png",
    });
  });

  it("strips markdown code spans from values and labels", async () => {
    const content = [
      "- **Name:** `Samantha`",
      "- `Creature`: Robot",
      "- **`Avatar`**: `avatars/openclaw.png`",
    ].join("\n");
    const parsed = await parseIdentityFromContent(content);
    expect(parsed).toEqual({
      name: "Samantha",
      creature: "Robot",
      avatar: "avatars/openclaw.png",
    });
  });

  it("still treats code-span-wrapped template placeholders as placeholders", async () => {
    const content = "- **Avatar:** `(workspace-relative path, http(s) URL, or data URI)`";
    const parsed = await parseIdentityFromContent(content);
    expect(parsed).toBeNull();
  });

  it("ignores an italic not-set placeholder", async () => {
    const parsed = await parseIdentityFromContent("- **Avatar:** *(not set yet)*");
    expect(parsed).toBeNull();
  });
});

describe("mergeIdentityMarkdownContent", () => {
  it("updates writable fields without clobbering richer identity sections", () => {
    const content = `
# IDENTITY.md - Agent Identity

- **Name:** C-3PO
- **Creature:** Flustered Protocol Droid
- **Vibe:** Anxious, detail-obsessed
- **Emoji:** 🤖

## Role

Fluent in over six million error messages.
`;

    const merged = mergeIdentityMarkdownContent(content, {
      name: "Patch Agent",
      emoji: "🦀",
      avatar: "avatars/patch.png",
    });

    expect(merged).toContain("- Name: Patch Agent");
    expect(merged).toContain("- **Creature:** Flustered Protocol Droid");
    expect(merged).toContain("- **Vibe:** Anxious, detail-obsessed");
    expect(merged).toContain("- Emoji: 🦀");
    expect(merged).toContain("- Avatar: avatars/patch.png");
    expect(merged).toContain("## Role");
    expect(merged).toContain("Fluent in over six million error messages.");
  });

  it("replaces duplicate writable lines with one normalized entry", () => {
    const merged = mergeIdentityMarkdownContent(
      `
- Name: Old Name
- Name: Older Name
- Emoji: 🙂
`,
      { name: "New Name", emoji: "🦀" },
    );

    expect(merged.match(/Name:/g)).toHaveLength(1);
    expect(merged).toContain("- Name: New Name");
    expect(merged).toContain("- Emoji: 🦀");
  });

  it("updates code-span-wrapped writable labels instead of inserting duplicates", () => {
    const merged = mergeIdentityMarkdownContent("- **`Name`**: Old Name\n", {
      name: "New Name",
    });

    expect(merged).toBe("- Name: New Name\n");
  });
});

describe("loadAgentIdentityFromWorkspace", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-identity-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it("loads identity values from IDENTITY.md", () => {
    fs.writeFileSync(
      path.join(tempDir, "IDENTITY.md"),
      ["- **Name:** Test Agent", "- **Emoji:** 🤖"].join("\n"),
      "utf-8",
    );

    expect(loadAgentIdentityFromWorkspace(tempDir)).toEqual({
      name: "Test Agent",
      emoji: "🤖",
    });
  });

  it("loads identity values from a symlinked IDENTITY.md", () => {
    if (process.platform === "win32") {
      return;
    }
    const targetPath = path.join(tempDir, "REAL_IDENTITY.md");
    fs.writeFileSync(targetPath, "- **Name:** Linked Agent", "utf-8");
    fs.symlinkSync(targetPath, path.join(tempDir, "IDENTITY.md"));

    expect(loadAgentIdentityFromWorkspace(tempDir)).toEqual({ name: "Linked Agent" });
  });

  it("loads an explicit identity file through a symlink", async () => {
    if (process.platform === "win32") {
      return;
    }
    const targetPath = path.join(tempDir, "REAL_IDENTITY.md");
    const identityPath = path.join(tempDir, "identity-link.md");
    fs.writeFileSync(targetPath, "- **Name:** Linked Agent", "utf-8");
    fs.symlinkSync(targetPath, identityPath);

    await expect(loadAgentIdentityFromFile(identityPath)).resolves.toEqual({
      name: "Linked Agent",
    });
  });

  it("does not infer an overflow from a missing path containing exceeds", async () => {
    const identityPath = path.join(tempDir, "identity-exceeds-limit.md");

    await expect(loadAgentIdentityFromFile(identityPath)).resolves.toBeNull();
  });

  it("returns null when IDENTITY.md exceeds the size cap", () => {
    fs.writeFileSync(
      path.join(tempDir, "IDENTITY.md"),
      "x".repeat(TEST_MAX_IDENTITY_FILE_BYTES + 1),
      "utf-8",
    );

    expect(loadAgentIdentityFromWorkspace(tempDir)).toBeNull();
  });
});
