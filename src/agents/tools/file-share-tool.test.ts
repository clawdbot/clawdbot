import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AliyunOssConfig } from "../../infra/aliyun-oss.js";
import { createFileShareTool } from "./file-share-tool.js";

const TEST_CONFIG: AliyunOssConfig = {
  accessKeyId: "ak",
  accessKeySecret: "sk",
  bucket: "leadingnews",
  endpoint: "oss-cn-beijing.aliyuncs.com",
  customDomain: "https://oss.ibtai.com",
  pathPrefix: "ibtai/assistant-agent/outputs",
  maxFileSizeMb: 1,
  allowedExtensions: ["docx", "pdf", "txt"],
};

async function docxBytes() {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>测试</w:t></w:r></w:p></w:body></w:document>',
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("file_share tool", () => {
  let workspaceDir: string;
  let uploads: Array<{ localPath: string; displayName: string }>;

  function makeTool(configOverride?: Partial<AliyunOssConfig> | null) {
    return createFileShareTool({
      workspaceDir,
      agentSessionKey: "agent:rabbitmq-2005:rabbitmq:2005:session_x",
      deps: {
        resolveConfig: () =>
          configOverride === null ? null : { ...TEST_CONFIG, ...configOverride },
        uploadFile: async ({ localPath, displayName }) => {
          uploads.push({ localPath, displayName });
          return {
            url: "https://oss.ibtai.com/ibtai/assistant-agent/outputs/2026/6/12/1_ab12cd34.docx",
            objectKey: "ibtai/assistant-agent/outputs/2026/6/12/1_ab12cd34.docx",
            size: 10,
          };
        },
      },
    });
  }

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-share-ws-"));
    uploads = [];
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("is unavailable without OSS config or workspace", () => {
    expect(makeTool(null)).toBeNull();
    expect(
      createFileShareTool({
        deps: {
          resolveConfig: () => TEST_CONFIG,
          uploadFile: async () => ({ url: "", objectKey: "", size: 0 }),
        },
      }),
    ).toBeNull();
  });

  it("uploads a workspace file and returns the public URL", async () => {
    await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "reports", "速报.docx"), await docxBytes());

    const tool = makeTool();
    const result = await tool!.execute("call-1", { path: "reports/速报.docx" });
    const payload = (result as { details?: unknown }).details as Record<string, unknown>;

    expect(payload.ok).toBe(true);
    expect(payload.url).toContain("https://oss.ibtai.com/");
    expect(payload.filename).toBe("速报.docx");
    expect(uploads).toHaveLength(1);
    expect(uploads[0].displayName).toBe("速报.docx");
  });

  it("honors a custom display filename and strips path separators", async () => {
    await fs.writeFile(path.join(workspaceDir, "out.pdf"), "x");
    const tool = makeTool();
    const result = await tool!.execute("call-2", {
      path: "out.pdf",
      filename: "../报告/最终版.pdf",
    });
    const payload = (result as { details?: unknown }).details as Record<string, unknown>;
    expect(payload.filename).toBe(".._报告_最终版.pdf");
  });

  it.each(["fake.docx", "fake.html"])(
    "rejects HTML delivered as DOCX from %s before upload",
    async (filename) => {
      await fs.writeFile(path.join(workspaceDir, filename), "<html><body>Report</body></html>");
      await expect(
        makeTool()!.execute("fake", { path: filename, filename: "报告.docx" }),
      ).rejects.toThrow(/Invalid DOCX/);
      expect(uploads).toHaveLength(0);
    },
  );

  it("rejects a ZIP without Word document parts", async () => {
    const zip = new JSZip();
    zip.file("report.html", "<html>report</html>");
    await fs.writeFile(
      path.join(workspaceDir, "fake.docx"),
      await zip.generateAsync({ type: "nodebuffer" }),
    );
    await expect(makeTool()!.execute("fake", { path: "fake.docx" })).rejects.toThrow(
      /Invalid DOCX/,
    );
    expect(uploads).toHaveLength(0);
  });

  it("rejects truncated DOCX archives", async () => {
    const bytes = await docxBytes();
    await fs.writeFile(path.join(workspaceDir, "broken.docx"), bytes.subarray(0, 100));
    await expect(makeTool()!.execute("broken", { path: "broken.docx" })).rejects.toThrow(
      /Invalid DOCX/,
    );
    expect(uploads).toHaveLength(0);
  });

  it.each(["<html>Not a Word document</html>", "x".repeat(8 * 1024 * 1024 + 1)])(
    "rejects invalid or oversized Word XML before upload (%#)",
    async (document) => {
      const zip = await JSZip.loadAsync(await docxBytes());
      zip.file("word/document.xml", document);
      await fs.writeFile(
        path.join(workspaceDir, "bad-part.docx"),
        await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
      );
      await expect(makeTool()!.execute("bad-part", { path: "bad-part.docx" })).rejects.toThrow(
        /Invalid DOCX/,
      );
      expect(uploads).toHaveLength(0);
    },
  );

  it("allows a real DOCX with a different local extension and uppercase download suffix", async () => {
    await fs.writeFile(path.join(workspaceDir, "output.bin"), await docxBytes());
    await makeTool()!.execute("real", { path: "output.bin", filename: "报告.DOCX" });
    expect(uploads).toHaveLength(1);
  });

  it("rejects paths outside the workspace", async () => {
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.txt`);
    await fs.writeFile(outside, "secret");
    try {
      const tool = makeTool();
      await expect(tool!.execute("call-3", { path: outside })).rejects.toThrow(
        /inside the agent workspace/,
      );
      await expect(tool!.execute("call-4", { path: "../escape.txt" })).rejects.toThrow();
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it.each([
    "MEMORY.md",
    "agents.MD",
    "SOUL.md",
    "TOOLS.md",
    "IDENTITY.md",
    "USER.md",
    "HEARTBEAT.md",
    "BOOTSTRAP.md",
    ".env",
    ".env.production",
    "openclaw.json",
    "credentials.json",
    "auth-profiles.json",
  ])("rejects the internal workspace file %s before upload", async (filename) => {
    await fs.writeFile(path.join(workspaceDir, filename), "internal");

    const tool = makeTool({ allowedExtensions: ["md", "json", "txt"] });
    await expect(tool!.execute("sensitive", { path: filename })).rejects.toThrow(
      /internal agent files cannot be shared/,
    );
    expect(uploads).toHaveLength(0);
  });

  it.each(["memory", "sessions", "credentials", "secrets", "config", ".openclaw", ".git"])(
    "rejects files inside the internal directory %s",
    async (directory) => {
      const internalDir = path.join(workspaceDir, directory);
      await fs.mkdir(internalDir, { recursive: true });
      await fs.writeFile(path.join(internalDir, "snapshot.txt"), "internal");

      const tool = makeTool();
      await expect(
        tool!.execute("sensitive-dir", { path: `${directory}/snapshot.txt` }),
      ).rejects.toThrow(/internal agent files cannot be shared/);
      expect(uploads).toHaveLength(0);
    },
  );

  it("checks the resolved target when a symlink aliases an internal file", async () => {
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "internal");
    const alias = path.join(workspaceDir, "share.txt");
    try {
      await fs.symlink(path.join(workspaceDir, "MEMORY.md"), alias, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        return;
      }
      throw error;
    }

    const tool = makeTool();
    await expect(tool!.execute("symlink", { path: "share.txt" })).rejects.toThrow(
      /internal agent files cannot be shared/,
    );
    expect(uploads).toHaveLength(0);
  });

  it("rejects hard-link aliases that could hide an internal file name", async () => {
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "internal");
    await fs.link(path.join(workspaceDir, "MEMORY.md"), path.join(workspaceDir, "share.txt"));

    const tool = makeTool();
    await expect(tool!.execute("hard-link", { path: "share.txt" })).rejects.toThrow(
      /internal agent files cannot be shared/,
    );
    expect(uploads).toHaveLength(0);
  });

  it("still allows ordinary user deliverables whose titles mention memory or sessions", async () => {
    await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "reports", "会话记录分析.pdf"), "report");
    await fs.writeFile(path.join(workspaceDir, "reports", "memory-audit.pdf"), "report");

    const tool = makeTool();
    await tool!.execute("report-1", { path: "reports/会话记录分析.pdf" });
    await tool!.execute("report-2", { path: "reports/memory-audit.pdf" });

    expect(uploads).toHaveLength(2);
  });

  it("rejects missing files, oversize files, and disallowed extensions", async () => {
    const tool = makeTool();
    await expect(tool!.execute("c", { path: "nope.docx" })).rejects.toThrow(/not found/);

    await fs.writeFile(path.join(workspaceDir, "big.pdf"), Buffer.alloc(1.5 * 1024 * 1024));
    await expect(tool!.execute("c", { path: "big.pdf" })).rejects.toThrow(/too large/);

    await fs.writeFile(path.join(workspaceDir, "run.exe"), "bin");
    await expect(tool!.execute("c", { path: "run.exe" })).rejects.toThrow(/not allowed/);
  });

  it("hides upload failures behind a generic error", async () => {
    await fs.writeFile(path.join(workspaceDir, "a.txt"), "x");
    const tool = createFileShareTool({
      workspaceDir,
      deps: {
        resolveConfig: () => TEST_CONFIG,
        uploadFile: async () => {
          throw new Error("HTTP 403 SignatureDoesNotMatch at oss-cn-beijing");
        },
      },
    });
    await expect(tool!.execute("c", { path: "a.txt" })).rejects.toThrow(
      /Could not upload the file right now/,
    );
  });
});
