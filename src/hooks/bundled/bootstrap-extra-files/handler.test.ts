// Bootstrap extra files hook tests cover extra file context injection.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import {
  type AgentBootstrapHookContext,
  createInternalHookEvent as createHookEvent,
} from "../../internal-hooks.js";
import handler from "./handler.js";

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    subsystem: "bootstrap-extra-files",
    isEnabled: () => false,
    trace: vi.fn(),
    debug: loggerMocks.debug,
    info: vi.fn(),
    warn: loggerMocks.warn,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
  }),
}));

function createBootstrapExtraConfig(paths: string[]): OpenClawConfig {
  return {
    hooks: {
      internal: {
        entries: {
          "bootstrap-extra-files": {
            enabled: true,
            paths,
          },
        },
      },
    },
  };
}

async function createBootstrapContext(params: {
  workspaceDir: string;
  cfg: OpenClawConfig;
  sessionKey: string;
  rootFiles: Array<{ name: string; content: string }>;
}): Promise<AgentBootstrapHookContext> {
  const bootstrapFiles = (await Promise.all(
    params.rootFiles.map(async (file) => ({
      name: file.name,
      path: await writeWorkspaceFile({
        dir: params.workspaceDir,
        name: file.name,
        content: file.content,
      }),
      content: file.content,
      missing: false,
    })),
  )) as AgentBootstrapHookContext["bootstrapFiles"];
  return {
    workspaceDir: params.workspaceDir,
    bootstrapFiles,
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  };
}

describe("bootstrap-extra-files hook", () => {
  it("appends extra bootstrap files from configured patterns", async () => {
    const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-");
    const extraDir = path.join(tempDir, "packages", "core");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "AGENTS.md"), "extra agents", "utf-8");

    const cfg = createBootstrapExtraConfig(["packages/*/AGENTS.md"]);
    const context = await createBootstrapContext({
      workspaceDir: tempDir,
      cfg,
      sessionKey: "agent:main:main",
      rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    const injected = context.bootstrapFiles.filter((f) => f.name === "AGENTS.md");
    expect(injected).toHaveLength(2);
    expect(injected.map((f) => path.relative(tempDir, f.path))).toContain(
      path.join("packages", "core", "AGENTS.md"),
    );
  });

  it("appends configured nested memory without applying session policy", async () => {
    const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-memory-");
    const extraDir = path.join(tempDir, "packages", "core");
    const sessionKey = "agent:main:slack:channel:c1";
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "MEMORY.md"), "nested memory", "utf-8");

    const cfg = createBootstrapExtraConfig(["packages/*/MEMORY.md"]);
    const context = await createBootstrapContext({
      workspaceDir: tempDir,
      cfg,
      sessionKey,
      rootFiles: [{ name: "MEMORY.md", content: "private root memory" }],
    });

    const event = createHookEvent("agent", "bootstrap", sessionKey, context);
    await handler(event);

    const relativePaths = context.bootstrapFiles.map((file) => path.relative(tempDir, file.path));
    expect(relativePaths).toContain("MEMORY.md");
    expect(relativePaths).toContain(path.join("packages", "core", "MEMORY.md"));
  });

  it("leaves subagent allowlist enforcement to the final resolver", async () => {
    const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-subagent-");
    const extraDir = path.join(tempDir, "packages", "persona");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "SOUL.md"), "extra persona", "utf-8");

    const cfg = createBootstrapExtraConfig(["packages/*/SOUL.md"]);
    const context = await createBootstrapContext({
      workspaceDir: tempDir,
      cfg,
      sessionKey: "agent:main:subagent:abc",
      rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:subagent:abc", context);
    await handler(event);
    expect(context.bootstrapFiles.map((f) => f.name).toSorted()).toEqual(["AGENTS.md", "SOUL.md"]);
  });

  it("does not warn when resolving a configured glob", async () => {
    loggerMocks.warn.mockClear();
    const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-under-limit-");
    const extraDir = path.join(tempDir, "packages", "core");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "AGENTS.md"), "extra agents", "utf-8");

    const cfg = createBootstrapExtraConfig(["packages/*/AGENTS.md"]);
    const context = await createBootstrapContext({
      workspaceDir: tempDir,
      cfg,
      sessionKey: "agent:main:main",
      rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });

  describe("diagnostic visibility", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("warns with io reason and drops the affected files when glob resolution fails", async () => {
      loggerMocks.warn.mockClear();
      loggerMocks.debug.mockClear();
      const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-io-");
      const extraDir = path.join(tempDir, "packages", "core");
      await fs.mkdir(extraDir, { recursive: true });
      await fs.writeFile(path.join(extraDir, "AGENTS.md"), "extra agents", "utf-8");

      // A non-ENOENT glob failure is a real fault: fs.glob walks past per-entry
      // read errors, so a throw here means the whole pattern failed to resolve.
      const globError = Object.assign(new Error("permission denied"), { code: "EACCES" });
      vi.spyOn(fs, "glob").mockImplementation(() => {
        throw globError;
      });

      const cfg = createBootstrapExtraConfig(["packages/*/AGENTS.md"]);
      const context = await createBootstrapContext({
        workspaceDir: tempDir,
        cfg,
        sessionKey: "agent:main:main",
        rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
      });

      const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
      await handler(event);

      expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
      const [message, fields] = loggerMocks.warn.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toContain("resolution failed");
      expect(fields.reasons).toEqual({ io: 1, security: 0 });
      expect(fields.paths).toEqual([path.resolve(tempDir, "packages/*/AGENTS.md")]);
      expect(fields.hint).toBeTruthy();

      // The failed pattern's files must not leak into the bootstrap set.
      const injected = context.bootstrapFiles.filter((f) => f.name === "AGENTS.md");
      expect(injected).toHaveLength(1);
      expect(injected.map((f) => path.relative(tempDir, f.path))).not.toContain(
        path.join("packages", "core", "AGENTS.md"),
      );
    });

    it("warns with security reason when a pattern escapes the workspace", async () => {
      loggerMocks.warn.mockClear();
      const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-security-");

      const cfg = createBootstrapExtraConfig(["../escape/AGENTS.md"]);
      const context = await createBootstrapContext({
        workspaceDir: tempDir,
        cfg,
        sessionKey: "agent:main:main",
        rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
      });

      const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
      await handler(event);

      expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
      const [, fields] = loggerMocks.warn.mock.calls[0] as [string, Record<string, unknown>];
      expect(fields.reasons).toEqual({ io: 0, security: 1 });
      expect(context.bootstrapFiles.filter((f) => f.name === "AGENTS.md")).toHaveLength(1);
    });

    it("keeps benign missing diagnostics at debug and never warns", async () => {
      loggerMocks.warn.mockClear();
      loggerMocks.debug.mockClear();
      const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-missing-");

      // Optional literal path that is simply absent — normal noise, not a fault.
      const cfg = createBootstrapExtraConfig(["does-not-exist/AGENTS.md"]);
      const context = await createBootstrapContext({
        workspaceDir: tempDir,
        cfg,
        sessionKey: "agent:main:main",
        rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
      });

      const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
      await handler(event);

      // Discriminating control: the pre-fix handler logged everything at debug,
      // so a benign-only run producing zero warns is exactly what proves the split.
      expect(loggerMocks.warn).not.toHaveBeenCalled();
      expect(loggerMocks.debug).toHaveBeenCalledTimes(1);
      const [, fields] = loggerMocks.debug.mock.calls[0] as [string, Record<string, unknown>];
      expect(fields.reasons).toEqual({ missing: 1 });
    });
  });
});
