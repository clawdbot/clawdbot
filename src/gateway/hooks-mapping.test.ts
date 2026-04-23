import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyHookMappings, resolveHookMappings } from "./hooks-mapping.js";

const baseUrl = new URL("http://127.0.0.1:18789/hooks/gmail");

describe("hooks mapping", () => {
  const gmailPayload = { messages: [{ subject: "Hello" }] };

  function expectSkippedTransformResult(result: Awaited<ReturnType<typeof applyHookMappings>>) {
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.action).toBeNull();
      expect("skipped" in result).toBe(true);
    }
  }

  function createGmailAgentMapping(params: {
    id: string;
    messageTemplate: string;
    model?: string;
    agentId?: string;
  }) {
    return {
      id: params.id,
      match: { path: "gmail" },
      action: "agent" as const,
      messageTemplate: params.messageTemplate,
      ...(params.model ? { model: params.model } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
    };
  }

  async function applyGmailMappings(config: Parameters<typeof resolveHookMappings>[0]) {
    const mappings = resolveHookMappings(config);
    return applyHookMappings(mappings, {
      payload: gmailPayload,
      headers: {},
      url: baseUrl,
      path: "gmail",
    });
  }

  function expectAgentMessage(
    result: Awaited<ReturnType<typeof applyHookMappings>> | undefined,
    expectedMessage: string,
  ) {
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.kind).toBe("agent");
      expect(result.action.message).toBe(expectedMessage);
    }
  }

  async function expectBlockedPrototypeTraversal(params: {
    id: string;
    messageTemplate: string;
    payload: Record<string, unknown>;
    expectedMessage: string;
  }) {
    const mappings = resolveHookMappings({
      mappings: [
        createGmailAgentMapping({
          id: params.id,
          messageTemplate: params.messageTemplate,
        }),
      ],
    });
    const result = await applyHookMappings(mappings, {
      payload: params.payload,
      headers: {},
      url: baseUrl,
      path: "gmail",
    });
    expectAgentMessage(result, params.expectedMessage);
  }

  async function applyNullTransformFromTempConfig(params: {
    configDir: string;
    transformsDir?: string;
  }) {
    const transformsRoot = path.join(params.configDir, "hooks", "transforms");
    const transformsDir = params.transformsDir
      ? path.join(transformsRoot, params.transformsDir)
      : transformsRoot;
    fs.mkdirSync(transformsDir, { recursive: true });
    fs.writeFileSync(path.join(transformsDir, "transform.mjs"), "export default () => null;");

    const mappings = resolveHookMappings(
      {
        transformsDir: params.transformsDir,
        mappings: [
          {
            match: { path: "skip" },
            action: "agent",
            transform: { module: "transform.mjs" },
          },
        ],
      },
      { configDir: params.configDir },
    );

    return applyHookMappings(mappings, {
      payload: {},
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/skip"),
      path: "skip",
    });
  }

  async function applyGmailTransformSessionKey(params: {
    tempPrefix: string;
    transformLines: string[];
    payload?: Record<string, unknown>;
    sessionKey?: string;
  }) {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), params.tempPrefix));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    fs.writeFileSync(path.join(transformsRoot, "transform.mjs"), params.transformLines.join("\n"));

    const mappings = resolveHookMappings(
      {
        mappings: [
          {
            match: { path: "gmail" },
            action: "agent",
            messageTemplate: "Subject: {{messages[0].subject}}",
            ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
            transform: { module: "transform.mjs" },
          },
        ],
      },
      { configDir },
    );

    return applyHookMappings(mappings, {
      payload: params.payload ?? gmailPayload,
      headers: {},
      url: baseUrl,
      path: "gmail",
    });
  }

  function expectAgentSessionKey(
    result: Awaited<ReturnType<typeof applyHookMappings>>,
    params: { sessionKey: string; sessionKeySource?: "static" | "templated" },
  ) {
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.sessionKey).toBe(params.sessionKey);
      expect(result.action.sessionKeySource).toBe(params.sessionKeySource);
    }
  }

  it("resolves gmail preset", () => {
    const mappings = resolveHookMappings({ presets: ["gmail"] });
    expect(mappings.length).toBeGreaterThan(0);
    expect(mappings[0]?.matchPath).toBe("gmail");
  });

  it("renders template from payload", async () => {
    const result = await applyGmailMappings({
      mappings: [
        createGmailAgentMapping({
          id: "demo",
          messageTemplate: "Subject: {{messages[0].subject}}",
        }),
      ],
    });
    expectAgentMessage(result, "Subject: Hello");
  });

  it("passes model override from mapping", async () => {
    const result = await applyGmailMappings({
      mappings: [
        createGmailAgentMapping({
          id: "demo",
          messageTemplate: "Subject: {{messages[0].subject}}",
          model: "openai/gpt-4.1-mini",
        }),
      ],
    });
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action && result.action.kind === "agent") {
      expect(result.action.model).toBe("openai/gpt-4.1-mini");
    }
  });

  it("marks template-derived session keys as templated", async () => {
    const result = await applyGmailMappings({
      mappings: [
        {
          id: "templated-session-key",
          match: { path: "gmail" },
          action: "agent",
          messageTemplate: "Subject: {{messages[0].subject}}",
          sessionKey: "hook:gmail:{{messages[0].subject}}",
        },
      ],
    });
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.sessionKey).toBe("hook:gmail:Hello");
      expect(result.action.sessionKeySource).toBe("templated");
    }
  });

  it("marks literal session keys as static", async () => {
    const result = await applyGmailMappings({
      mappings: [
        {
          id: "static-session-key",
          match: { path: "gmail" },
          action: "agent",
          messageTemplate: "Subject: {{messages[0].subject}}",
          sessionKey: "hook:gmail:static",
        },
      ],
    });
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.sessionKey).toBe("hook:gmail:static");
      expect(result.action.sessionKeySource).toBe("static");
    }
  });

  it("runs transform module", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    const modPath = path.join(transformsRoot, "transform.mjs");
    const placeholder = "${payload.name}";
    fs.writeFileSync(
      modPath,
      `export default ({ payload }) => ({ kind: "wake", text: \`Ping ${placeholder}\` });`,
    );

    const mappings = resolveHookMappings(
      {
        mappings: [
          {
            match: { path: "custom" },
            action: "agent",
            transform: { module: "transform.mjs" },
          },
        ],
      },
      { configDir },
    );

    const result = await applyHookMappings(mappings, {
      payload: { name: "Ada" },
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/custom"),
      path: "custom",
    });

    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "wake") {
      expect(result.action.kind).toBe("wake");
      expect(result.action.text).toBe("Ping Ada");
    }
  });

  it("treats transform-provided session keys as templated by default", async () => {
    const result = await applyGmailTransformSessionKey({
      tempPrefix: "openclaw-config-sessionkey-xform-",
      payload: { subject: "external" },
      sessionKey: "hook:gmail:static",
      transformLines: [
        "export default ({ payload }) => ({",
        '  kind: "agent",',
        '  message: "Transformed",',
        "  sessionKey: `hook:gmail:${payload.subject}`,",
        "});",
      ],
    });

    expectAgentSessionKey(result, {
      sessionKey: "hook:gmail:external",
      sessionKeySource: "templated",
    });
  });

  it("uses transform-provided static session key source metadata", async () => {
    const result = await applyGmailTransformSessionKey({
      tempPrefix: "openclaw-config-sessionkey-static-",
      sessionKey: "hook:gmail:{{messages[0].subject}}",
      transformLines: [
        "export default () => ({",
        '  kind: "agent",',
        '  message: "Transformed",',
        '  sessionKey: "hook:gmail:fixed",',
        '  sessionKeySource: "static",',
        "});",
      ],
    });

    expectAgentSessionKey(result, { sessionKey: "hook:gmail:fixed", sessionKeySource: "static" });
  });

  it("treats empty transform session keys as absent for source tracking", async () => {
    const result = await applyGmailTransformSessionKey({
      tempPrefix: "openclaw-config-sessionkey-empty-",
      sessionKey: "hook:gmail:{{messages[0].subject}}",
      transformLines: [
        "export default () => ({",
        '  kind: "agent",',
        '  message: "Transformed",',
        '  sessionKey: "",',
        '  sessionKeySource: "templated",',
        "});",
      ],
    });

    expectAgentSessionKey(result, { sessionKey: "" });
  });

  it("defaults invalid transform session key source metadata to templated", async () => {
    const result = await applyGmailTransformSessionKey({
      tempPrefix: "openclaw-config-sessionkey-invalid-",
      transformLines: [
        "export default () => ({",
        '  kind: "agent",',
        '  message: "Transformed",',
        '  sessionKey: "hook:gmail:from-transform",',
        '  sessionKeySource: "bogus",',
        "});",
      ],
    });

    expectAgentSessionKey(result, {
      sessionKey: "hook:gmail:from-transform",
      sessionKeySource: "templated",
    });
  });

  it("rejects transform module traversal outside transformsDir", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-traversal-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    expect(() =>
      resolveHookMappings(
        {
          mappings: [
            {
              match: { path: "custom" },
              action: "agent",
              transform: { module: "../evil.mjs" },
            },
          ],
        },
        { configDir },
      ),
    ).toThrow(/must be within/);
  });

  it("rejects absolute transform module path outside transformsDir", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-abs-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    const outside = path.join(os.tmpdir(), "evil.mjs");
    expect(() =>
      resolveHookMappings(
        {
          mappings: [
            {
              match: { path: "custom" },
              action: "agent",
              transform: { module: outside },
            },
          ],
        },
        { configDir },
      ),
    ).toThrow(/must be within/);
  });

  it("rejects transformsDir traversal outside the transforms root", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-xformdir-trav-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    expect(() =>
      resolveHookMappings(
        {
          transformsDir: "..",
          mappings: [
            {
              match: { path: "custom" },
              action: "agent",
              transform: { module: "transform.mjs" },
            },
          ],
        },
        { configDir },
      ),
    ).toThrow(/Hook transformsDir/);
  });

  it("rejects transformsDir absolute path outside the transforms root", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-xformdir-abs-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    expect(() =>
      resolveHookMappings(
        {
          transformsDir: os.tmpdir(),
          mappings: [
            {
              match: { path: "custom" },
              action: "agent",
              transform: { module: "transform.mjs" },
            },
          ],
        },
        { configDir },
      ),
    ).toThrow(/Hook transformsDir/);
  });

  it("accepts transformsDir subdirectory within the transforms root", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-xformdir-ok-"));
    const result = await applyNullTransformFromTempConfig({ configDir, transformsDir: "subdir" });
    expectSkippedTransformResult(result);
  });

  it.runIf(process.platform !== "win32")(
    "rejects transform module symlink escape outside transformsDir",
    () => {
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-symlink-module-"));
      const transformsRoot = path.join(configDir, "hooks", "transforms");
      fs.mkdirSync(transformsRoot, { recursive: true });
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-outside-module-"));
      const outsideModule = path.join(outsideDir, "evil.mjs");
      fs.writeFileSync(outsideModule, 'export default () => ({ kind: "wake", text: "owned" });');
      fs.symlinkSync(outsideModule, path.join(transformsRoot, "linked.mjs"));
      expect(() =>
        resolveHookMappings(
          {
            mappings: [
              {
                match: { path: "custom" },
                action: "agent",
                transform: { module: "linked.mjs" },
              },
            ],
          },
          { configDir },
        ),
      ).toThrow(/must be within/);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects transformsDir symlink escape outside transforms root",
    () => {
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-symlink-dir-"));
      const transformsRoot = path.join(configDir, "hooks", "transforms");
      fs.mkdirSync(transformsRoot, { recursive: true });
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-outside-dir-"));
      fs.writeFileSync(path.join(outsideDir, "transform.mjs"), "export default () => null;");
      fs.symlinkSync(outsideDir, path.join(transformsRoot, "escape"), "dir");
      expect(() =>
        resolveHookMappings(
          {
            transformsDir: "escape",
            mappings: [
              {
                match: { path: "custom" },
                action: "agent",
                transform: { module: "transform.mjs" },
              },
            ],
          },
          { configDir },
        ),
      ).toThrow(/Hook transformsDir/);
    },
  );

  it.runIf(process.platform !== "win32")("accepts in-root transform module symlink", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-symlink-ok-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    const nestedDir = path.join(transformsRoot, "nested");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, "transform.mjs"), "export default () => null;");
    fs.symlinkSync(path.join(nestedDir, "transform.mjs"), path.join(transformsRoot, "linked.mjs"));

    const mappings = resolveHookMappings(
      {
        mappings: [
          {
            match: { path: "skip" },
            action: "agent",
            transform: { module: "linked.mjs" },
          },
        ],
      },
      { configDir },
    );

    const result = await applyHookMappings(mappings, {
      payload: {},
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/skip"),
      path: "skip",
    });

    expectSkippedTransformResult(result);
  });

  it("treats null transform as a handled skip", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-skip-"));
    const result = await applyNullTransformFromTempConfig({ configDir });
    expectSkippedTransformResult(result);
  });

  it("prefers explicit mappings over presets", async () => {
    const result = await applyGmailMappings({
      presets: ["gmail"],
      mappings: [
        createGmailAgentMapping({
          id: "override",
          messageTemplate: "Override subject: {{messages[0].subject}}",
        }),
      ],
    });
    expectAgentMessage(result, "Override subject: Hello");
  });

  it("passes agentId from mapping", async () => {
    const result = await applyGmailMappings({
      mappings: [
        createGmailAgentMapping({
          id: "hooks-agent",
          messageTemplate: "Subject: {{messages[0].subject}}",
          agentId: "hooks",
        }),
      ],
    });
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.agentId).toBe("hooks");
    }
  });

  it("agentId is undefined when not set", async () => {
    const result = await applyGmailMappings({
      mappings: [
        createGmailAgentMapping({
          id: "no-agent",
          messageTemplate: "Subject: {{messages[0].subject}}",
        }),
      ],
    });
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.agentId).toBeUndefined();
    }
  });

  it("caches transform functions by module path and export name", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-export-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    const modPath = path.join(transformsRoot, "multi-export.mjs");
    fs.writeFileSync(
      modPath,
      [
        'export function transformA() { return { kind: "wake", text: "from-A" }; }',
        'export function transformB() { return { kind: "wake", text: "from-B" }; }',
      ].join("\n"),
    );

    const mappingsA = resolveHookMappings(
      {
        mappings: [
          {
            match: { path: "testA" },
            action: "agent",
            messageTemplate: "unused",
            transform: { module: "multi-export.mjs", export: "transformA" },
          },
        ],
      },
      { configDir },
    );

    const mappingsB = resolveHookMappings(
      {
        mappings: [
          {
            match: { path: "testB" },
            action: "agent",
            messageTemplate: "unused",
            transform: { module: "multi-export.mjs", export: "transformB" },
          },
        ],
      },
      { configDir },
    );

    const resultA = await applyHookMappings(mappingsA, {
      payload: {},
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/testA"),
      path: "testA",
    });

    const resultB = await applyHookMappings(mappingsB, {
      payload: {},
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/testB"),
      path: "testB",
    });

    expect(resultA?.ok).toBe(true);
    if (resultA?.ok && resultA.action?.kind === "wake") {
      expect(resultA.action.text).toBe("from-A");
    }

    expect(resultB?.ok).toBe(true);
    if (resultB?.ok && resultB.action?.kind === "wake") {
      expect(resultB.action.text).toBe("from-B");
    }
  });

  it("rejects missing message", async () => {
    const mappings = resolveHookMappings({
      mappings: [{ match: { path: "noop" }, action: "agent" }],
    });
    const result = await applyHookMappings(mappings, {
      payload: {},
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/noop"),
      path: "noop",
    });
    expect(result?.ok).toBe(false);
  });

  describe("prototype pollution protection", () => {
    it("blocks __proto__ traversal in webhook payload", async () => {
      await expectBlockedPrototypeTraversal({
        id: "proto-test",
        messageTemplate: "value: {{__proto__}}",
        payload: { __proto__: { polluted: true } } as Record<string, unknown>,
        expectedMessage: "value: ",
      });
    });

    it("blocks constructor traversal in webhook payload", async () => {
      await expectBlockedPrototypeTraversal({
        id: "constructor-test",
        messageTemplate: "type: {{constructor.name}}",
        payload: { constructor: { name: "INJECTED" } } as Record<string, unknown>,
        expectedMessage: "type: ",
      });
    });

    it("blocks prototype traversal in webhook payload", async () => {
      await expectBlockedPrototypeTraversal({
        id: "prototype-test",
        messageTemplate: "val: {{prototype}}",
        payload: { prototype: "leaked" } as Record<string, unknown>,
        expectedMessage: "val: ",
      });
    });
  });
});
