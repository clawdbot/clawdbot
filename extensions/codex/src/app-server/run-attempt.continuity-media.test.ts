import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createParams,
  createResumeHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { writeCodexAppServerBinding } from "./session-binding.test-helpers.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

describe("Codex attachment continuity", () => {
  it.each([
    { scenario: "managed text", source: "managed", mime: "text/plain", name: "notes.txt" },
    { scenario: "workspace JSON", source: "path", mime: "application/json", name: "data.json" },
    {
      scenario: "captionless markdown",
      source: "managed",
      mime: "text/markdown",
      name: "notes.md",
      blank: true,
    },
    {
      scenario: "mixed files",
      source: "managed",
      mime: "text/plain",
      name: "notes.txt",
      mixed: true,
    },
    {
      scenario: "MIME policy",
      source: "managed",
      mime: "text/plain",
      name: "notes.txt",
      blocked: "mime",
    },
    {
      scenario: "byte limit",
      source: "managed",
      mime: "text/plain",
      name: "notes.txt",
      blocked: "bytes",
    },
    {
      scenario: "URL policy",
      source: "url",
      mime: "text/plain",
      name: "notes.txt",
      blocked: "url",
    },
  ] as const)("restores saved $scenario through native resume", async (scenario) => {
    const sessionId = "session-continuity-attachments";
    const sessionFile = `agent:main:${sessionId}`;
    const storePath = path.join(tempDir, "attachment-continuity.sqlite");
    const workspaceDir = path.join(tempDir, "attachment-workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const params = createParams(sessionFile, workspaceDir);
    await attachSqliteSessionTarget(params, storePath, sessionId);
    const target = { agentId: "main", sessionId, sessionKey: params.sessionKey!, storePath };
    const cutoff = Date.now();
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: params.modelId,
      modelProvider: "openai",
      historyCoveredThrough: new Date(cutoff).toISOString(),
      dynamicToolsFingerprint: "[]",
      webSearchThreadConfigFingerprint: JSON.stringify({
        "features.standalone_web_search": false,
        web_search: "disabled",
      }),
    });
    const token = "CONTINUITY_FILE_BYTES_94d80b";
    const secondToken = "CONTINUITY_SECOND_FILE_BYTES_153c72";
    const media: Array<{
      path?: string;
      url?: string;
      contentType: string;
      fileName: string;
      hydrationSuppressed: boolean;
    }> = [];
    const files = [
      {
        name: scenario.name,
        mime: scenario.mime,
        text: scenario.mime === "application/json" ? JSON.stringify({ token }) : token,
      },
      ...("mixed" in scenario
        ? [
            {
              name: "second.json",
              mime: "application/json",
              text: JSON.stringify({ token: secondToken }),
            },
          ]
        : []),
    ];
    for (const file of files) {
      let source: { path: string } | { url: string };
      if (scenario.source === "path") {
        const filePath = path.join(workspaceDir, file.name);
        await fs.writeFile(filePath, file.text);
        source = { path: filePath };
      } else if (scenario.source === "url") {
        source = { url: "https://example.invalid/attachment.txt" };
      } else {
        const saved = await saveMediaBuffer(
          Buffer.from(file.text),
          file.mime,
          "inbound",
          undefined,
          file.name,
        );
        source = { url: `media://inbound/${saved.id}` };
      }
      media.push({
        ...source,
        contentType: file.mime,
        fileName: file.name,
        hydrationSuppressed: true,
      });
    }
    const caption = "blank" in scenario ? "" : "Read the attached document and use its value.";
    const sourceMessage = {
      role: "user" as const,
      content: scenario.source === "path" ? [{ type: "text" as const, text: caption }] : caption,
      timestamp: cutoff + 1,
      idempotencyKey: "saved-attachment-input:user",
      __openclaw: { media },
    };
    await appendSessionTranscriptMessageByIdentity({
      ...target,
      message: sourceMessage,
      now: cutoff + 1,
    });
    if ("blocked" in scenario) {
      params.config = {
        ...params.config,
        gateway: {
          http: {
            endpoints: {
              responses: {
                files: {
                  ...(scenario.blocked === "mime" ? { allowedMimes: ["application/pdf"] } : {}),
                  ...(scenario.blocked === "bytes" ? { maxBytes: 4 } : {}),
                  ...(scenario.blocked === "url" ? { allowUrl: false } : {}),
                },
              },
            },
          },
        },
      };
    }
    params.prompt = "Continue the saved request.";
    const started = createDeferred<void>();
    params.onAgentEvent = (event) => {
      if (event.stream === "lifecycle" && event.data.phase === "start") {
        started.resolve();
      }
    };
    const abort = new AbortController();
    params.abortSignal = abort.signal;
    const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
    vi.useFakeTimers();
    const harness = createResumeHarness();
    const run = runCodexAppServerAttempt(params);
    try {
      await started.promise;
      await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
      expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, timedOut: false });
      const request = harness.requests.find((entry) => entry.method === "turn/start");
      const input = asOptionalRecord(request?.params)?.input;
      const prompt = Array.isArray(input)
        ? input
            .flatMap((part) => {
              const text = asOptionalRecord(part)?.text;
              return typeof text === "string" ? [text] : [];
            })
            .join("\n")
        : "";
      expect(harness.requests.some((entry) => entry.method === "thread/resume")).toBe(true);
      expect(prompt).toContain("Continue the saved request.");
      if ("blocked" in scenario) {
        expect(prompt).not.toContain(token);
        expect(prompt).toContain(
          scenario.blocked === "mime"
            ? "[Attachment type not allowed: text/plain]"
            : scenario.blocked === "url"
              ? "[Attachment skipped: URL file sources are disabled]"
              : "[Attachment could not be read]",
        );
      } else {
        expect(prompt).toContain(token);
        if ("mixed" in scenario) {
          expect(prompt).toContain(secondToken);
          expect(prompt.indexOf(token)).toBeLessThan(prompt.indexOf(secondToken));
        }
      }
      const saved = (await readSessionTranscriptEvents(target)).flatMap((event) => {
        const message = asOptionalRecord(asOptionalRecord(event)?.message);
        return message?.idempotencyKey === sourceMessage.idempotencyKey ? [message] : [];
      });
      expect(saved).toEqual([sourceMessage]);
    } finally {
      abort.abort("test cleanup");
      await run;
      closeHost();
    }
  });
  it.each(["inline", "offloaded", "current", "closed"] as const)(
    "restores real image bytes with exact source ownership (%s)",
    async (mode) => {
      const sessionId = "session-continuity-images";
      const sessionFile = `agent:main:${sessionId}`;
      const storePath = path.join(tempDir, "image-continuity.sqlite");
      const workspaceDir = path.join(tempDir, "image-workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const params = createParams(sessionFile, workspaceDir);
      params.model = { ...params.model, input: ["text", "image"] };
      await attachSqliteSessionTarget(params, storePath, sessionId);
      const target = { agentId: "main", sessionId, sessionKey: params.sessionKey!, storePath };
      const cutoff = Date.now();
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-existing",
        cwd: workspaceDir,
        model: params.modelId,
        modelProvider: "openai",
        historyCoveredThrough: new Date(cutoff).toISOString(),
        dynamicToolsFingerprint: "[]",
        webSearchThreadConfigFingerprint: JSON.stringify({
          "features.standalone_web_search": false,
          web_search: "disabled",
        }),
      });
      const blue = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 });
      const green = createSolidPngBuffer(1, 1, { r: 0, g: 255, b: 0 });
      const image = {
        type: "image" as const,
        mimeType: "image/png",
        data: blue.toString("base64"),
      };
      const saved = await saveMediaBuffer(blue, "image/png", "inbound", undefined, "blue.png");
      const historical = {
        role: "user" as const,
        timestamp: cutoff + 1,
        idempotencyKey: "historical-image:user",
        content:
          mode === "inline"
            ? [{ type: "text" as const, text: "Read this image." }, image]
            : "Read this image.",
        __openclaw: {
          media: [
            { url: `media://inbound/${saved.id}`, contentType: "image/png", fileName: "blue.png" },
          ],
          mediaImageLayout: {
            slots: [{ kind: mode === "inline" ? "inline" : "offloaded", factIndex: 0 }],
          },
          ...(mode === "inline" ? { mediaImageBlockFactIndexes: [0] } : {}),
        },
      };
      await appendSessionTranscriptMessageByIdentity({
        ...target,
        message: historical,
        now: cutoff + 1,
      });
      params.prompt = "Read this image.";
      if (mode === "current") {
        const currentImage = { ...image, data: green.toString("base64") };
        params.images = [currentImage];
        const current = {
          role: "user" as const,
          timestamp: cutoff + 2,
          idempotencyKey: "current-image:user",
          content: [{ type: "text" as const, text: params.prompt }, currentImage],
        };
        await appendSessionTranscriptMessageByIdentity({
          ...target,
          message: current,
          now: cutoff + 2,
        });
        // Model an already committed current source with no read fence, so both
        // rows enter projection and only exact current-source identity removes it.
        params.userTurnTranscriptRecorder = {
          message: current,
          resolveMessage: async () => current,
          getAdmissionReceipt: () => undefined,
          markRuntimePersistencePending: () => {},
          markRuntimePersisted: () => {},
          markBlocked: () => {},
          hasPersisted: () => true,
          isBlocked: () => false,
          hasRuntimePersistencePending: () => false,
          waitForRuntimePersistence: async () => {},
          persistApproved: async () => undefined,
          persistBlocked: async () => undefined,
          persistFallback: async () => undefined,
        };
      }
      const abort = new AbortController();
      params.abortSignal = abort.signal;
      const started = createDeferred<void>();
      params.onAgentEvent = (event) => {
        if (event.stream === "lifecycle" && event.data.phase === "start") {
          started.resolve();
        }
      };
      const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
      if (mode === "closed") {
        const prepare = params.hostCapabilities.prepareContextMedia!;
        params.hostCapabilities = {
          ...params.hostCapabilities,
          prepareContextMedia: async (request) => {
            const prepared = await prepare(request);
            expect(prepared.images).toHaveLength(1);
            closeHost();
            return prepared;
          },
        };
      }
      vi.useFakeTimers();
      const harness = createResumeHarness();
      const run = runCodexAppServerAttempt(params);
      try {
        if (mode === "closed") {
          await expect(run).rejects.toThrow(/active|closed|authority/i);
          expect(harness.requests.filter((request) => request.method === "turn/start")).toEqual([]);
        } else {
          await started.promise;
          await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
          expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, timedOut: false });
          const request = harness.requests.find((entry) => entry.method === "turn/start");
          const input = asOptionalRecord(request?.params)?.input;
          expect(Array.isArray(input)).toBe(true);
          const images = Array.isArray(input)
            ? input.filter((part) => asOptionalRecord(part)?.type === "image")
            : [];
          expect(images).toEqual([
            { type: "image", url: `data:image/png;base64,${blue.toString("base64")}` },
            ...(mode === "current"
              ? [{ type: "image", url: `data:image/png;base64,${green.toString("base64")}` }]
              : []),
          ]);
        }
        const rows = (await readSessionTranscriptEvents(target)).flatMap((event) => {
          const message = asOptionalRecord(asOptionalRecord(event)?.message);
          return message?.idempotencyKey === historical.idempotencyKey ? [message] : [];
        });
        expect(rows).toEqual([historical]);
      } finally {
        abort.abort("test cleanup");
        await run.catch(() => undefined);
        closeHost();
      }
    },
  );
});
