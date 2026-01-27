import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import { createMoltbotCodingTools } from "./pi-tools.js";

const defaultTools = createMoltbotCodingTools();

describe("createMoltbotCodingTools", () => {
  it("keeps read tool image metadata intact", async () => {
    const readTool = defaultTools.find((tool) => tool.name === "read");
    expect(readTool).toBeDefined();

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-read-"));
    try {
      const imagePath = path.join(tmpDir, "sample.png");
      const png = await sharp({
        create: {
          width: 8,
          height: 8,
          channels: 3,
          background: { r: 0, g: 128, b: 255 },
        },
      })
        .png()
        .toBuffer();
      await fs.writeFile(imagePath, png);

      const result = await readTool?.execute("tool-1", {
        path: imagePath,
      });

      expect(result?.content?.some((block) => block.type === "image")).toBe(true);
      const text = result?.content?.find((block) => block.type === "text") as
        | { text?: string }
        | undefined;
      expect(text?.text ?? "").toContain("Read image file [image/png]");
      const image = result?.content?.find((block) => block.type === "image") as
        | { mimeType?: string }
        | undefined;
      expect(image?.mimeType).toBe("image/png");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
  it("returns text content without image blocks for text files", async () => {
    const tools = createMoltbotCodingTools();
    const readTool = tools.find((tool) => tool.name === "read");
    expect(readTool).toBeDefined();

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-read-"));
    try {
      const textPath = path.join(tmpDir, "sample.txt");
      const contents = "Hello from moltbot read tool.";
      await fs.writeFile(textPath, contents, "utf8");

      const result = await readTool?.execute("tool-2", {
        path: textPath,
      });

      expect(result?.content?.some((block) => block.type === "image")).toBe(false);
      const textBlocks = result?.content?.filter((block) => block.type === "text") as
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
    const sandbox = {
      enabled: true,
      sessionKey: "sandbox:test",
      workspaceDir: path.join(os.tmpdir(), "moltbot-sandbox"),
      agentWorkspaceDir: path.join(os.tmpdir(), "moltbot-workspace"),
      workspaceAccess: "none",
      containerName: "moltbot-sbx-test",
      containerWorkdir: "/workspace",
      docker: {
        image: "moltbot-sandbox:bookworm-slim",
        containerPrefix: "moltbot-sbx-",
        workdir: "/workspace",
        readOnlyRoot: true,
        tmpfs: [],
        network: "none",
        user: "1000:1000",
        capDrop: ["ALL"],
        env: { LANG: "C.UTF-8" },
      },
      tools: {
        allow: ["bash"],
        deny: ["browser"],
      },
      browserAllowHostControl: false,
    };
    const tools = createMoltbotCodingTools({ sandbox });
    expect(tools.some((tool) => tool.name === "exec")).toBe(true);
    expect(tools.some((tool) => tool.name === "read")).toBe(false);
    expect(tools.some((tool) => tool.name === "browser")).toBe(false);
  });
  it("hard-disables write/edit when sandbox workspaceAccess is ro", () => {
    const sandbox = {
      enabled: true,
      sessionKey: "sandbox:test",
      workspaceDir: path.join(os.tmpdir(), "moltbot-sandbox"),
      agentWorkspaceDir: path.join(os.tmpdir(), "moltbot-workspace"),
      workspaceAccess: "ro",
      containerName: "moltbot-sbx-test",
      containerWorkdir: "/workspace",
      docker: {
        image: "moltbot-sandbox:bookworm-slim",
        containerPrefix: "moltbot-sbx-",
        workdir: "/workspace",
        readOnlyRoot: true,
        tmpfs: [],
        network: "none",
        user: "1000:1000",
        capDrop: ["ALL"],
        env: { LANG: "C.UTF-8" },
      },
      tools: {
        allow: ["read", "write", "edit"],
        deny: [],
      },
      browserAllowHostControl: false,
    };
    const tools = createMoltbotCodingTools({ sandbox });
    expect(tools.some((tool) => tool.name === "read")).toBe(true);
    expect(tools.some((tool) => tool.name === "write")).toBe(false);
    expect(tools.some((tool) => tool.name === "edit")).toBe(false);
  });
  it("filters tools by agent tool policy even without sandbox", () => {
    const tools = createMoltbotCodingTools({
      config: { tools: { deny: ["browser"] } },
    });
    expect(tools.some((tool) => tool.name === "exec")).toBe(true);
    expect(tools.some((tool) => tool.name === "browser")).toBe(false);
  });
});
