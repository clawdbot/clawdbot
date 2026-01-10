import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { __testing, createClawdbotCodingTools } from "./pi-tools.js";
import { createBrowserTool } from "./tools/browser-tool.js";

describe("createClawdbotCodingTools", () => {
  it("keeps browser tool schema OpenAI-compatible without normalization", () => {
    const browser = createBrowserTool();
    const schema = browser.parameters as { type?: unknown; anyOf?: unknown };
    expect(schema.type).toBe("object");
    expect(schema.anyOf).toBeUndefined();
  });

  it("merges properties for union tool schemas", () => {
    const tools = createClawdbotCodingTools();
    const browser = tools.find((tool) => tool.name === "browser");
    expect(browser).toBeDefined();
    const parameters = browser?.parameters as {
      anyOf?: unknown[];
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(parameters.properties?.action).toBeDefined();
    expect(parameters.properties?.controlUrl).toBeDefined();
    expect(parameters.properties?.targetUrl).toBeDefined();
    expect(parameters.properties?.request).toBeDefined();
    expect(parameters.required ?? []).toContain("action");
  });

  it("exposes raw for gateway config.apply tool calls", () => {
    const tools = createClawdbotCodingTools();
    const gateway = tools.find((tool) => tool.name === "gateway");
    expect(gateway).toBeDefined();

    const parameters = gateway?.parameters as {
      type?: unknown;
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(parameters.type).toBe("object");
    expect(parameters.properties?.raw).toBeDefined();
    expect(parameters.required ?? []).not.toContain("raw");
  });

  it("flattens anyOf-of-literals to enum for provider compatibility", () => {
    const tools = createClawdbotCodingTools();
    const browser = tools.find((tool) => tool.name === "browser");
    expect(browser).toBeDefined();

    const parameters = browser?.parameters as {
      properties?: Record<string, unknown>;
    };
    const action = parameters.properties?.action as
      | {
          type?: unknown;
          enum?: unknown[];
          anyOf?: unknown[];
        }
      | undefined;

    expect(action?.type).toBe("string");
    expect(action?.anyOf).toBeUndefined();
    expect(Array.isArray(action?.enum)).toBe(true);
    expect(action?.enum).toContain("act");

    const format = parameters.properties?.format as
      | {
          type?: unknown;
          enum?: unknown[];
          anyOf?: unknown[];
        }
      | undefined;
    expect(format?.type).toBe("string");
    expect(format?.anyOf).toBeUndefined();
    expect(format?.enum).toEqual(["aria", "ai"]);
  });

  it("inlines local $ref before removing unsupported keywords", () => {
    const cleaned = __testing.cleanToolSchemaForGemini({
      type: "object",
      properties: {
        foo: { $ref: "#/$defs/Foo" },
      },
      $defs: {
        Foo: { type: "string", enum: ["a", "b"] },
      },
    }) as {
      $defs?: unknown;
      properties?: Record<string, unknown>;
    };

    expect(cleaned.$defs).toBeUndefined();
    expect(cleaned.properties).toBeDefined();
    expect(cleaned.properties?.foo).toMatchObject({
      type: "string",
      enum: ["a", "b"],
    });
  });

  it("preserves action enums in normalized schemas", () => {
    const tools = createClawdbotCodingTools();
    const toolNames = [
      "browser",
      "canvas",
      "nodes",
      "cron",
      "gateway",
      "message",
    ];

    const collectActionValues = (
      schema: unknown,
      values: Set<string>,
    ): void => {
      if (!schema || typeof schema !== "object") return;
      const record = schema as Record<string, unknown>;
      if (typeof record.const === "string") values.add(record.const);
      if (Array.isArray(record.enum)) {
        for (const value of record.enum) {
          if (typeof value === "string") values.add(value);
        }
      }
      if (Array.isArray(record.anyOf)) {
        for (const variant of record.anyOf) {
          collectActionValues(variant, values);
        }
      }
    };

    for (const name of toolNames) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      const parameters = tool?.parameters as {
        properties?: Record<string, unknown>;
      };
      const action = parameters.properties?.action as
        | { const?: unknown; enum?: unknown[] }
        | undefined;
      const values = new Set<string>();
      collectActionValues(action, values);

      const min =
        name === "gateway"
          ? 1
          : // Most tools expose multiple actions; keep this signal so schemas stay useful to models.
            2;
      expect(values.size).toBeGreaterThanOrEqual(min);
    }
  });

  it("includes bash and process tools", () => {
    const tools = createClawdbotCodingTools();
    expect(tools.some((tool) => tool.name === "bash")).toBe(true);
    expect(tools.some((tool) => tool.name === "process")).toBe(true);
  });

  it("keeps canonical tool names for Anthropic OAuth (pi-ai remaps on the wire)", () => {
    const tools = createClawdbotCodingTools({
      modelProvider: "anthropic",
      modelAuthMode: "oauth",
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("bash")).toBe(true);
    expect(names.has("read")).toBe(true);
    expect(names.has("write")).toBe(true);
    expect(names.has("edit")).toBe(true);
  });

  it("provides top-level object schemas for all tools", () => {
    const tools = createClawdbotCodingTools();
    const offenders = tools
      .map((tool) => {
        const schema =
          tool.parameters && typeof tool.parameters === "object"
            ? (tool.parameters as Record<string, unknown>)
            : null;
        return {
          name: tool.name,
          type: schema?.type,
          keys: schema ? Object.keys(schema).sort() : null,
        };
      })
      .filter((entry) => entry.type !== "object");

    expect(offenders).toEqual([]);
  });

  it("does not expose provider-specific message tools", () => {
    const tools = createClawdbotCodingTools({ messageProvider: "discord" });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("discord")).toBe(false);
    expect(names.has("slack")).toBe(false);
    expect(names.has("telegram")).toBe(false);
    expect(names.has("whatsapp")).toBe(false);
  });

  it("filters session tools for sub-agent sessions by default", () => {
    const tools = createClawdbotCodingTools({
      sessionKey: "agent:main:subagent:test",
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("sessions_list")).toBe(false);
    expect(names.has("sessions_history")).toBe(false);
    expect(names.has("sessions_send")).toBe(false);
    expect(names.has("sessions_spawn")).toBe(false);

    expect(names.has("read")).toBe(true);
    expect(names.has("bash")).toBe(true);
    expect(names.has("process")).toBe(true);
  });

  it("supports allow-only sub-agent tool policy", () => {
    const tools = createClawdbotCodingTools({
      sessionKey: "agent:main:subagent:test",
      // Intentionally partial config; only fields used by pi-tools are provided.
      config: {
        tools: {
          subagents: {
            tools: {
              // Policy matching is case-insensitive
              allow: ["read"],
            },
          },
        },
      },
    });
    expect(tools.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("keeps read tool image metadata intact", async () => {
    const tools = createClawdbotCodingTools();
    const readTool = tools.find((tool) => tool.name === "read");
    expect(readTool).toBeDefined();

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-read-"));
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

      expect(result?.content?.some((block) => block.type === "image")).toBe(
        true,
      );
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
    const tools = createClawdbotCodingTools();
    const readTool = tools.find((tool) => tool.name === "read");
    expect(readTool).toBeDefined();

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-read-"));
    try {
      const textPath = path.join(tmpDir, "sample.txt");
      const contents = "Hello from clawdbot read tool.";
      await fs.writeFile(textPath, contents, "utf8");

      const result = await readTool?.execute("tool-2", {
        path: textPath,
      });

      expect(result?.content?.some((block) => block.type === "image")).toBe(
        false,
      );
      const textBlocks = result?.content?.filter(
        (block) => block.type === "text",
      ) as Array<{ text?: string }> | undefined;
      expect(textBlocks?.length ?? 0).toBeGreaterThan(0);
      const combinedText = textBlocks
        ?.map((block) => block.text ?? "")
        .join("\n");
      expect(combinedText).toContain(contents);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("filters tools by sandbox policy", () => {
    const sandbox = {
      enabled: true,
      sessionKey: "sandbox:test",
      workspaceDir: path.join(os.tmpdir(), "clawdbot-sandbox"),
      agentWorkspaceDir: path.join(os.tmpdir(), "clawdbot-workspace"),
      workspaceAccess: "none",
      containerName: "clawdbot-sbx-test",
      containerWorkdir: "/workspace",
      docker: {
        image: "clawdbot-sandbox:bookworm-slim",
        containerPrefix: "clawdbot-sbx-",
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
    };
    const tools = createClawdbotCodingTools({ sandbox });
    expect(tools.some((tool) => tool.name === "bash")).toBe(true);
    expect(tools.some((tool) => tool.name === "read")).toBe(false);
    expect(tools.some((tool) => tool.name === "browser")).toBe(false);
  });

  it("hard-disables write/edit when sandbox workspaceAccess is ro", () => {
    const sandbox = {
      enabled: true,
      sessionKey: "sandbox:test",
      workspaceDir: path.join(os.tmpdir(), "clawdbot-sandbox"),
      agentWorkspaceDir: path.join(os.tmpdir(), "clawdbot-workspace"),
      workspaceAccess: "ro",
      containerName: "clawdbot-sbx-test",
      containerWorkdir: "/workspace",
      docker: {
        image: "clawdbot-sandbox:bookworm-slim",
        containerPrefix: "clawdbot-sbx-",
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
    };
    const tools = createClawdbotCodingTools({ sandbox });
    expect(tools.some((tool) => tool.name === "read")).toBe(true);
    expect(tools.some((tool) => tool.name === "write")).toBe(false);
    expect(tools.some((tool) => tool.name === "edit")).toBe(false);
  });

  it("filters tools by agent tool policy even without sandbox", () => {
    const tools = createClawdbotCodingTools({
      config: { tools: { deny: ["browser"] } },
    });
    expect(tools.some((tool) => tool.name === "bash")).toBe(true);
    expect(tools.some((tool) => tool.name === "browser")).toBe(false);
  });

  it("removes unsupported JSON Schema keywords for Cloud Code Assist API compatibility", () => {
    const tools = createClawdbotCodingTools();

    // Helper to recursively check schema for unsupported keywords
    const unsupportedKeywords = new Set([
      "patternProperties",
      "additionalProperties",
      "$schema",
      "$id",
      "$ref",
      "$defs",
      "definitions",
      "examples",
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "multipleOf",
      "pattern",
      "format",
      "minItems",
      "maxItems",
      "uniqueItems",
      "minProperties",
      "maxProperties",
    ]);

    const findUnsupportedKeywords = (
      schema: unknown,
      path: string,
    ): string[] => {
      const found: string[] = [];
      if (!schema || typeof schema !== "object") return found;
      if (Array.isArray(schema)) {
        schema.forEach((item, i) => {
          found.push(...findUnsupportedKeywords(item, `${path}[${i}]`));
        });
        return found;
      }

      const record = schema as Record<string, unknown>;
      const properties =
        record.properties &&
        typeof record.properties === "object" &&
        !Array.isArray(record.properties)
          ? (record.properties as Record<string, unknown>)
          : undefined;
      if (properties) {
        for (const [key, value] of Object.entries(properties)) {
          found.push(
            ...findUnsupportedKeywords(value, `${path}.properties.${key}`),
          );
        }
      }

      for (const [key, value] of Object.entries(record)) {
        if (key === "properties") continue;
        if (unsupportedKeywords.has(key)) {
          found.push(`${path}.${key}`);
        }
        if (value && typeof value === "object") {
          found.push(...findUnsupportedKeywords(value, `${path}.${key}`));
        }
      }
      return found;
    };

    for (const tool of tools) {
      const violations = findUnsupportedKeywords(
        tool.parameters,
        `${tool.name}.parameters`,
      );
      expect(violations).toEqual([]);
    }
  });

  it("uses workspaceDir for Read tool path resolution", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-ws-"));
    try {
      // Create a test file in the "workspace"
      const testFile = "test-workspace-file.txt";
      const testContent = "workspace path resolution test";
      await fs.writeFile(path.join(tmpDir, testFile), testContent, "utf8");

      // Create tools with explicit workspaceDir
      const tools = createClawdbotCodingTools({ workspaceDir: tmpDir });
      const readTool = tools.find((tool) => tool.name === "read");
      expect(readTool).toBeDefined();

      // Read using relative path - should resolve against workspaceDir
      const result = await readTool?.execute("tool-ws-1", {
        path: testFile,
      });

      const textBlocks = result?.content?.filter(
        (block) => block.type === "text",
      ) as Array<{ text?: string }> | undefined;
      const combinedText = textBlocks
        ?.map((block) => block.text ?? "")
        .join("\n");
      expect(combinedText).toContain(testContent);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses workspaceDir for Write tool path resolution", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-ws-"));
    try {
      const testFile = "test-write-file.txt";
      const testContent = "written via workspace path";

      // Create tools with explicit workspaceDir
      const tools = createClawdbotCodingTools({ workspaceDir: tmpDir });
      const writeTool = tools.find((tool) => tool.name === "write");
      expect(writeTool).toBeDefined();

      // Write using relative path - should resolve against workspaceDir
      await writeTool?.execute("tool-ws-2", {
        path: testFile,
        content: testContent,
      });

      // Verify file was written to workspaceDir
      const written = await fs.readFile(path.join(tmpDir, testFile), "utf8");
      expect(written).toBe(testContent);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses workspaceDir for Edit tool path resolution", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-ws-"));
    try {
      const testFile = "test-edit-file.txt";
      const originalContent = "hello world";
      const expectedContent = "hello universe";
      await fs.writeFile(path.join(tmpDir, testFile), originalContent, "utf8");

      // Create tools with explicit workspaceDir
      const tools = createClawdbotCodingTools({ workspaceDir: tmpDir });
      const editTool = tools.find((tool) => tool.name === "edit");
      expect(editTool).toBeDefined();

      // Edit using relative path - should resolve against workspaceDir
      await editTool?.execute("tool-ws-3", {
        path: testFile,
        oldText: "world",
        newText: "universe",
      });

      // Verify file was edited in workspaceDir
      const edited = await fs.readFile(path.join(tmpDir, testFile), "utf8");
      expect(edited).toBe(expectedContent);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to process.cwd() when workspaceDir not provided", () => {
    const prevCwd = process.cwd();
    const tools = createClawdbotCodingTools();
    // Tools should be created without error
    expect(tools.some((tool) => tool.name === "read")).toBe(true);
    expect(tools.some((tool) => tool.name === "write")).toBe(true);
    expect(tools.some((tool) => tool.name === "edit")).toBe(true);
    // cwd should be unchanged
    expect(process.cwd()).toBe(prevCwd);
  });
});
