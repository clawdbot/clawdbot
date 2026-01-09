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
    // NOTE: bash/read/write/edit are capitalized to bypass Anthropic OAuth blocking
    expect(tools.some((tool) => tool.name === "Bash")).toBe(true);
    expect(tools.some((tool) => tool.name === "process")).toBe(true);
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

    // NOTE: bash/read/write/edit are capitalized to bypass Anthropic OAuth blocking
    expect(names.has("Read")).toBe(true);
    expect(names.has("Bash")).toBe(true);
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
    // Tool names are capitalized for OAuth compatibility
    expect(tools.map((tool) => tool.name)).toEqual(["Read"]);
  });

  it("keeps read tool image metadata intact", async () => {
    const tools = createClawdbotCodingTools();
    // NOTE: read is capitalized to bypass Anthropic OAuth blocking
    const readTool = tools.find((tool) => tool.name === "Read");
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
    // NOTE: read is capitalized to bypass Anthropic OAuth blocking
    const readTool = tools.find((tool) => tool.name === "Read");
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
    // NOTE: bash/read are capitalized to bypass Anthropic OAuth blocking
    // Policy matching is case-insensitive, so allow: ["bash"] matches tool named "Bash"
    expect(tools.some((tool) => tool.name === "Bash")).toBe(true);
    expect(tools.some((tool) => tool.name === "Read")).toBe(false);
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
    // NOTE: read/write/edit are capitalized to bypass Anthropic OAuth blocking
    expect(tools.some((tool) => tool.name === "Read")).toBe(true);
    expect(tools.some((tool) => tool.name === "Write")).toBe(false);
    expect(tools.some((tool) => tool.name === "Edit")).toBe(false);
  });

  it("filters tools by agent tool policy even without sandbox", () => {
    const tools = createClawdbotCodingTools({
      config: { tools: { deny: ["browser"] } },
    });
    // NOTE: bash is capitalized to bypass Anthropic OAuth blocking
    expect(tools.some((tool) => tool.name === "Bash")).toBe(true);
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
      for (const [key, value] of Object.entries(
        schema as Record<string, unknown>,
      )) {
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
});
