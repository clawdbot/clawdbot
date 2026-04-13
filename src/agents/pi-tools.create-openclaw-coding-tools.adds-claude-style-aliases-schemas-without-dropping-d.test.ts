import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./pi-tools.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { createPiToolsSandboxContext } from "./test-helpers/pi-tools-sandbox-context.js";

const tinyPngBuffer = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2f7z8AAAAASUVORK5CYII=",
  "base64",
);

describe("createOpenClawCodingTools", () => {
  it("returns image-aware read metadata for images and text-only blocks for text files", async () => {
    const defaultTools = createOpenClawCodingTools();
    const readTool = defaultTools.find((tool) => tool.name === "read");
    expect(readTool).toBeDefined();

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-"));
    try {
      const imagePath = path.join(tmpDir, "sample.png");
      await fs.writeFile(imagePath, tinyPngBuffer);

      const imageResult = await readTool?.execute("tool-1", {
        path: imagePath,
      });

      const imageBlocks = imageResult?.content?.filter((block) => block.type === "image") as
        | Array<{ mimeType?: string }>
        | undefined;
      const imageTextBlocks = imageResult?.content?.filter((block) => block.type === "text") as
        | Array<{ text?: string }>
        | undefined;
      const imageText = imageTextBlocks?.map((block) => block.text ?? "").join("\n") ?? "";
      expect(imageText).toContain("Read image file [image/png]");
      if ((imageBlocks?.length ?? 0) > 0) {
        expect(imageBlocks?.every((block) => block.mimeType === "image/png")).toBe(true);
      } else {
        expect(imageText).toContain("[Image omitted:");
      }

      const textPath = path.join(tmpDir, "sample.txt");
      const contents = "Hello from openclaw read tool.";
      await fs.writeFile(textPath, contents, "utf8");

      const textResult = await readTool?.execute("tool-2", {
        path: textPath,
      });

      expect(textResult?.content?.some((block) => block.type === "image")).toBe(false);
      const textBlocks = textResult?.content?.filter((block) => block.type === "text") as
        | Array<{ text?: string }>
        | undefined;
      expect(textBlocks?.length ?? 0).toBeGreaterThan(0);
      const combinedText = textBlocks?.map((block) => block.text ?? "").join("\n");
      expect(combinedText).toContain(contents);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
  it("filters tools by sandbox policy", () => {
    const sandboxDir = path.join(os.tmpdir(), "openclaw-sandbox");
    const sandbox = createPiToolsSandboxContext({
      workspaceDir: sandboxDir,
      agentWorkspaceDir: path.join(os.tmpdir(), "openclaw-workspace"),
      workspaceAccess: "none" as const,
      fsBridge: createHostSandboxFsBridge(sandboxDir),
      tools: {
        allow: ["bash"],
        deny: ["browser"],
      },
    });
    const tools = createOpenClawCodingTools({ sandbox });
    expect(tools.some((tool) => tool.name === "exec")).toBe(true);
    expect(tools.some((tool) => tool.name === "read")).toBe(false);
    expect(tools.some((tool) => tool.name === "browser")).toBe(false);
  });
  it("hard-disables write/edit when sandbox workspaceAccess is ro", () => {
    const sandboxDir = path.join(os.tmpdir(), "openclaw-sandbox");
    const sandbox = createPiToolsSandboxContext({
      workspaceDir: sandboxDir,
      agentWorkspaceDir: path.join(os.tmpdir(), "openclaw-workspace"),
      workspaceAccess: "ro" as const,
      fsBridge: createHostSandboxFsBridge(sandboxDir),
      tools: {
        allow: ["read", "write", "edit"],
        deny: [],
      },
    });
    const tools = createOpenClawCodingTools({ sandbox });
    expect(tools.some((tool) => tool.name === "read")).toBe(true);
    expect(tools.some((tool) => tool.name === "write")).toBe(false);
    expect(tools.some((tool) => tool.name === "edit")).toBe(false);
  });
});
