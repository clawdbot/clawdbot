/**
 * Tests for skill upload gateway methods and archive validation.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { GatewayRequestHandlers } from "./types.js";

const agentScopeState = vi.hoisted(() => ({
  workspaceDir: "",
}));

const installSecurityScanState = vi.hoisted(() => ({
  evaluateSkillInstallPolicy: vi.fn(),
}));

const replaceFileState = vi.hoisted(() => ({
  publishFailureTarget: "",
  publishFailures: 0,
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/agent-scope.js")>();
  return {
    ...actual,
    listAgentIds: vi.fn(() => ["main"]),
    resolveAgentWorkspaceDir: vi.fn(() => agentScopeState.workspaceDir),
    resolveDefaultAgentId: vi.fn(() => "main"),
  };
});

vi.mock("../../plugins/install-security-scan.js", () => ({
  evaluateSkillInstallPolicy: installSecurityScanState.evaluateSkillInstallPolicy,
}));

vi.mock("../../infra/replace-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/replace-file.js")>();
  return {
    ...actual,
    movePathWithCopyFallback: async (
      options: Parameters<typeof actual.movePathWithCopyFallback>[0],
    ) => {
      if (
        replaceFileState.publishFailures === 0 &&
        replaceFileState.publishFailureTarget &&
        options.from.includes(".openclaw-install-stage-") &&
        options.to === replaceFileState.publishFailureTarget
      ) {
        replaceFileState.publishFailures += 1;
        throw new Error("publish boom");
      }
      return await actual.movePathWithCopyFallback(options);
    },
  };
});

let tempDirs: string[] = [];
let testStates: OpenClawTestState[] = [];

type CallResult = {
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string };
};

async function makeHarness(): Promise<{
  handlers: GatewayRequestHandlers;
  stateDir: string;
  workspaceDir: string;
}> {
  const testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-upload-handler-",
  });
  testStates.push(testState);
  const stateDir = testState.stateDir;
  const workspaceDir = testState.workspaceDir;
  agentScopeState.workspaceDir = workspaceDir;
  vi.resetModules();
  const { skillsHandlers } = await import("./skills.js");
  return { handlers: skillsHandlers, stateDir, workspaceDir };
}

function makeContext(
  config: Record<string, unknown> = {
    skills: { install: { allowUploadedArchives: true } },
  },
) {
  return {
    getRuntimeConfig: () => config,
    logGateway: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
}

async function call(
  handlers: GatewayRequestHandlers,
  method: string,
  params: Record<string, unknown>,
  options: { config?: Record<string, unknown> } = {},
): Promise<CallResult> {
  const handler = handlers[method];
  if (!handler) {
    throw new Error(`missing handler: ${method}`);
  }
  let result: CallResult | undefined;
  await handler({
    params,
    req: { method } as never,
    client: null,
    isWebchatConnect: () => false,
    context: makeContext(options.config) as never,
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
  });
  if (!result) {
    throw new Error(`handler did not respond: ${method}`);
  }
  return result;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
    throw new Error(`Expected path to be missing: ${targetPath}`);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  }
}

function skillUploadExists(stateDir: string, uploadId: string): boolean {
  const { db } = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  return Boolean(
    db.prepare("SELECT 1 AS found FROM skill_uploads WHERE upload_id = ?").get(uploadId),
  );
}

function expectError(result: CallResult, code: string, message: string): void {
  expect(result.error?.code).toBe(code);
  expect(result.error?.message).toBe(message);
}

function firstCallArg<T>(mock: { mock: { calls: unknown[][] } }, _type?: (value: T) => T): T {
  const callLocal = mock.mock.calls.at(0);
  if (!callLocal) {
    throw new Error("Expected first mock call");
  }
  return callLocal[0] as T;
}

async function makeSkillArchive(params: {
  name?: string;
  description?: string;
  body?: string;
  rootDir?: string;
  skillFileName?: string;
  traversal?: boolean;
  missingSkill?: boolean;
}): Promise<Buffer> {
  const zip = new JSZip();
  const prefix = params.rootDir ? `${params.rootDir.replace(/\/+$/, "")}/` : "";
  if (params.missingSkill) {
    zip.file(`${prefix}README.md`, "not a skill");
  } else {
    zip.file(
      `${prefix}${params.skillFileName ?? "SKILL.md"}`,
      [
        "---",
        `name: ${params.name ?? "Uploaded Demo"}`,
        `description: ${params.description ?? "Installed from upload"}`,
        "---",
        "",
        params.body ?? "# Uploaded demo",
        "",
      ].join("\n"),
    );
  }
  if (params.traversal) {
    zip.file("../evil.txt", "owned");
  }
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

async function uploadArchive(
  handlers: GatewayRequestHandlers,
  params: {
    archive: Buffer;
    slug: string;
    force?: boolean;
  },
): Promise<{ uploadId: string; sha256: string }> {
  const digest = sha256(params.archive);
  const begin = await call(handlers, "skills.upload.begin", {
    kind: "skill-archive",
    slug: params.slug,
    sizeBytes: params.archive.length,
    sha256: digest,
    force: params.force,
  });
  expect(begin.ok).toBe(true);
  const uploadId = (begin.payload as { uploadId: string }).uploadId;
  const chunk = await call(handlers, "skills.upload.chunk", {
    uploadId,
    offset: 0,
    dataBase64: params.archive.toString("base64"),
  });
  expect(chunk.ok).toBe(true);
  const commit = await call(handlers, "skills.upload.commit", {
    uploadId,
    sha256: digest,
  });
  expect(commit.ok).toBe(true);
  return { uploadId, sha256: digest };
}

describe("skill upload gateway handlers", () => {
  beforeEach(() => {
    tempDirs = [];
    testStates = [];
    replaceFileState.publishFailureTarget = "";
    replaceFileState.publishFailures = 0;
    installSecurityScanState.evaluateSkillInstallPolicy.mockReset();
    installSecurityScanState.evaluateSkillInstallPolicy.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    await Promise.all([
      ...tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
      ...testStates.splice(0).map((state) => state.cleanup()),
    ]);
  });

  it("rejects upload archive RPCs and upload installs when disabled by config", async () => {
    const { handlers, stateDir } = await makeHarness();
    const config = { skills: { install: { allowUploadedArchives: false } } };
    const archive = await makeSkillArchive({});
    const begin = await call(
      handlers,
      "skills.upload.begin",
      {
        kind: "skill-archive",
        slug: "disabled-skill",
        sizeBytes: archive.length,
      },
      { config },
    );

    expect(begin.ok).toBe(false);
    expect(begin.error?.code).toBe("UNAVAILABLE");
    expect(begin.error?.message).toContain("skills.install.allowUploadedArchives");
    await expectPathMissing(path.join(stateDir, "tmp", "skill-uploads"));

    const install = await call(
      handlers,
      "skills.install",
      {
        source: "upload",
        uploadId: randomUUID(),
        slug: "disabled-skill",
      },
      { config },
    );
    expect(install.ok).toBe(false);
    expect(install.error?.code).toBe("UNAVAILABLE");
    expect(install.error?.message).toContain("skills.install.allowUploadedArchives");
  });

  it("uploads, installs, cleans up, and reports the skill from status", async () => {
    const { handlers, stateDir, workspaceDir } = await makeHarness();
    const archive = await makeSkillArchive({
      name: "Uploaded Demo",
      rootDir: "archive-internal-name",
    });
    const { uploadId, sha256: digest } = await uploadArchive(handlers, {
      archive,
      slug: "uploaded-demo",
    });

    const install = await call(handlers, "skills.install", {
      source: "upload",
      uploadId,
      slug: "uploaded-demo",
      sha256: digest,
    });

    expect(install.ok).toBe(true);
    expect((install.payload as { ok?: unknown }).ok).toBe(true);
    expect((install.payload as { slug?: unknown }).slug).toBe("uploaded-demo");
    expect((install.payload as { sha256?: unknown }).sha256).toBe(digest);
    await expect(
      fs.readFile(path.join(workspaceDir, "skills", "uploaded-demo", "SKILL.md"), "utf8"),
    ).resolves.toContain("Uploaded Demo");
    await expectPathMissing(path.join(workspaceDir, "skills", "archive-internal-name"));
    expect(skillUploadExists(stateDir, uploadId)).toBe(false);
    await expectPathMissing(path.join(stateDir, "tmp", "skill-uploads"));

    const status = await call(handlers, "skills.status", {});
    expect(status.ok).toBe(true);
    expect(JSON.stringify(status.payload)).toContain("Uploaded Demo");
  });

  it("rejects install before commit and missing upload ids", async () => {
    const { handlers } = await makeHarness();
    const archive = await makeSkillArchive({});
    const begin = await call(handlers, "skills.upload.begin", {
      kind: "skill-archive",
      slug: "pending-skill",
      sizeBytes: archive.length,
    });
    const uploadId = (begin.payload as { uploadId: string }).uploadId;

    const pending = await call(handlers, "skills.install", {
      source: "upload",
      uploadId,
      slug: "pending-skill",
    });
    expect(pending.ok).toBe(false);
    expect(pending.error?.message).toContain("upload is not committed");

    const missing = await call(handlers, "skills.install", {
      source: "upload",
      uploadId: randomUUID(),
      slug: "missing-skill",
    });
    expect(missing.ok).toBe(false);
    expect(missing.error?.message).toContain("upload not found");
  });

  it("binds slug and force to begin parameters", async () => {
    const { handlers } = await makeHarness();
    const archive = await makeSkillArchive({});
    const first = await uploadArchive(handlers, {
      archive,
      slug: "bound-skill",
    });

    const slugSwitch = await call(handlers, "skills.install", {
      source: "upload",
      uploadId: first.uploadId,
      slug: "other-skill",
    });
    expect(slugSwitch.ok).toBe(false);
    expect(slugSwitch.error?.message).toContain("install slug does not match upload slug");

    const second = await uploadArchive(handlers, {
      archive,
      slug: "forced-skill",
      force: true,
    });
    const forceSwitch = await call(handlers, "skills.install", {
      source: "upload",
      uploadId: second.uploadId,
      slug: "forced-skill",
    });
    expect(forceSwitch.ok).toBe(false);
    expect(forceSwitch.error?.message).toContain("install force does not match upload force");
  });

  it("rejects install sha mismatch and removes the terminal upload", async () => {
    const { handlers, stateDir } = await makeHarness();
    const upload = await uploadArchive(handlers, {
      archive: await makeSkillArchive({}),
      slug: "sha-bound-skill",
    });

    const install = await call(handlers, "skills.install", {
      source: "upload",
      uploadId: upload.uploadId,
      slug: "sha-bound-skill",
      sha256: "0".repeat(64),
    });

    expect(install.ok).toBe(false);
    expectError(install, "INVALID_REQUEST", "install sha256 does not match uploaded archive");
    expect(skillUploadExists(stateDir, upload.uploadId)).toBe(false);
  });

  it("rejects expired committed uploads through skills.install", async () => {
    const { handlers, stateDir } = await makeHarness();
    const upload = await uploadArchive(handlers, {
      archive: await makeSkillArchive({}),
      slug: "expired-skill",
    });
    openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } })
      .db.prepare("UPDATE skill_uploads SET expires_at = ? WHERE upload_id = ?")
      .run(Date.now() - 1, upload.uploadId);

    const install = await call(handlers, "skills.install", {
      source: "upload",
      uploadId: upload.uploadId,
      slug: "expired-skill",
    });

    expect(install.ok).toBe(false);
    expectError(install, "INVALID_REQUEST", "upload has expired");
    expect(skillUploadExists(stateDir, upload.uploadId)).toBe(false);
  });

  it("rejects invalid slugs, missing SKILL.md, and archive traversal", async () => {
    const { handlers, stateDir, workspaceDir } = await makeHarness();
    const invalidSlug = await call(handlers, "skills.upload.begin", {
      kind: "skill-archive",
      slug: "../escape",
      sizeBytes: 1,
    });
    expect(invalidSlug.ok).toBe(false);
    expect(invalidSlug.error?.message).toContain("Invalid skill slug");

    const missingSkill = await uploadArchive(handlers, {
      archive: await makeSkillArchive({ missingSkill: true }),
      slug: "missing-skill-md",
    });
    const missingInstall = await call(handlers, "skills.install", {
      source: "upload",
      uploadId: missingSkill.uploadId,
      slug: "missing-skill-md",
    });
    expect(missingInstall.ok).toBe(false);
    expect(missingInstall.error?.code).toBe("INVALID_REQUEST");
    expect(missingInstall.error?.message).toContain("SKILL.md");
    expect(skillUploadExists(stateDir, missingSkill.uploadId)).toBe(false);

    const legacyMarker = await uploadArchive(handlers, {
      archive: await makeSkillArchive({
        rootDir: "legacy-root",
        skillFileName: "skills.md",
      }),
      slug: "legacy-marker",
    });
    const legacyMarkerInstall = await call(handlers, "skills.install", {
      source: "upload",
      uploadId: legacyMarker.uploadId,
      slug: "legacy-marker",
    });
    expect(legacyMarkerInstall.ok).toBe(false);
    expect(legacyMarkerInstall.error?.code).toBe("INVALID_REQUEST");
    expect(legacyMarkerInstall.error?.message).toContain("SKILL.md");
    expect(skillUploadExists(stateDir, legacyMarker.uploadId)).toBe(false);

    const traversal = await uploadArchive(handlers, {
      archive: await makeSkillArchive({ traversal: true }),
      slug: "traversal-skill",
    });
    const traversalInstall = await call(handlers, "skills.install", {
      source: "upload",
      uploadId: traversal.uploadId,
      slug: "traversal-skill",
    });
    expect(traversalInstall.ok).toBe(false);
    expect(traversalInstall.error?.code).toBe("INVALID_REQUEST");
    expect(traversalInstall.error?.message).toMatch(
      /escapes destination|absolute|extract archive/i,
    );
    await expectPathMissing(path.join(workspaceDir, "skills", "traversal-skill"));
  });

  it("treats install policy blocks as terminal invalid uploads", async () => {
    const { handlers, stateDir } = await makeHarness();
    installSecurityScanState.evaluateSkillInstallPolicy.mockResolvedValueOnce({
      blocked: {
        code: "security_scan_blocked",
        reason: 'blocked by install policy: Skill "scan-blocked" is not approved.',
      },
    });
    const upload = await uploadArchive(handlers, {
      archive: await makeSkillArchive({}),
      slug: "scan-blocked",
    });

    const install = await call(handlers, "skills.install", {
      source: "upload",
      uploadId: upload.uploadId,
      slug: "scan-blocked",
    });

    expect(install.ok).toBe(false);
    expect(install.error?.code).toBe("INVALID_REQUEST");
    expect(install.error?.message).toContain("blocked by install policy");
    const scanInput = firstCallArg<{
      origin?: { type?: string; uploadId?: string };
      skillName?: string;
    }>(installSecurityScanState.evaluateSkillInstallPolicy);
    expect(scanInput.origin?.type).toBe("upload");
    expect(scanInput.origin?.uploadId).toBe(upload.uploadId);
    expect(scanInput.skillName).toBe("scan-blocked");
    expect(skillUploadExists(stateDir, upload.uploadId)).toBe(false);
  });

  it("preserves existing installs unless force was bound at begin", async () => {
    const { handlers, stateDir, workspaceDir } = await makeHarness();
    const first = await uploadArchive(handlers, {
      archive: await makeSkillArchive({
        name: "Replace Demo",
        body: "first version",
      }),
      slug: "replace-demo",
    });
    expect(
      (
        await call(handlers, "skills.install", {
          source: "upload",
          uploadId: first.uploadId,
          slug: "replace-demo",
        })
      ).ok,
    ).toBe(true);

    const blocked = await uploadArchive(handlers, {
      archive: await makeSkillArchive({
        name: "Replace Demo",
        body: "second version",
      }),
      slug: "replace-demo",
    });
    const blockedInstall = await call(handlers, "skills.install", {
      source: "upload",
      uploadId: blocked.uploadId,
      slug: "replace-demo",
    });
    expect(blockedInstall.ok).toBe(false);
    expect(blockedInstall.error?.code).toBe("INVALID_REQUEST");
    expect(blockedInstall.error?.message).toContain("already exists");
    expect(skillUploadExists(stateDir, blocked.uploadId)).toBe(false);

    const forced = await uploadArchive(handlers, {
      archive: await makeSkillArchive({
        name: "Replace Demo",
        body: "second version",
      }),
      slug: "replace-demo",
      force: true,
    });
    const forcedInstall = await call(handlers, "skills.install", {
      source: "upload",
      uploadId: forced.uploadId,
      slug: "replace-demo",
      force: true,
    });
    expect(forcedInstall.ok).toBe(true);
    await expect(
      fs.readFile(path.join(workspaceDir, "skills", "replace-demo", "SKILL.md"), "utf8"),
    ).resolves.toContain("second version");
  });

  it("keeps the previous skill when force replacement publish fails", async () => {
    const { handlers, stateDir, workspaceDir } = await makeHarness();
    const first = await uploadArchive(handlers, {
      archive: await makeSkillArchive({
        name: "Rollback Demo",
        body: "first version",
      }),
      slug: "rollback-demo",
    });
    expect(
      (
        await call(handlers, "skills.install", {
          source: "upload",
          uploadId: first.uploadId,
          slug: "rollback-demo",
        })
      ).ok,
    ).toBe(true);
    replaceFileState.publishFailureTarget = path.join(
      await fs.realpath(path.join(workspaceDir, "skills")),
      "rollback-demo",
    );

    const forced = await uploadArchive(handlers, {
      archive: await makeSkillArchive({
        name: "Rollback Demo",
        body: "second version",
      }),
      slug: "rollback-demo",
      force: true,
    });

    const install = await call(handlers, "skills.install", {
      source: "upload",
      uploadId: forced.uploadId,
      slug: "rollback-demo",
      force: true,
    });

    expect(install.ok).toBe(false);
    expect(install.error?.code).toBe("UNAVAILABLE");
    expect(install.error?.message).toContain("publish boom");
    await expect(
      fs.readFile(path.join(workspaceDir, "skills", "rollback-demo", "SKILL.md"), "utf8"),
    ).resolves.toContain("first version");
    expect(skillUploadExists(stateDir, forced.uploadId)).toBe(true);
  });
});
