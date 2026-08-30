import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { applyMediaUnderstanding } from "./apply.js";
import { transcribeFirstAudio } from "./audio-preflight.js";
import { createSafeAudioFixtureBuffer } from "./runner.test-utils.js";

describe("audio preflight attachment handoff", () => {
  it.each([
    { name: "default selection", attachments: undefined, emptyFirst: false },
    { name: "last preference", attachments: { prefer: "last" as const }, emptyFirst: false },
    {
      name: "all attachments",
      attachments: { mode: "all" as const, maxAttachments: 2 },
      emptyFirst: false,
    },
    {
      name: "empty first transcript",
      attachments: { mode: "all" as const, maxAttachments: 2 },
      emptyFirst: true,
    },
  ])("keeps first-only preflight separate from $name", async ({ attachments, emptyFirst }) => {
    await withTestDir({ prefix: "openclaw-audio-preflight-" }, async (dir) => {
      const callsPath = path.join(dir, "calls.txt");
      const media = await Promise.all(
        ["previous.wav", "first.wav", "second.wav"].map(async (name) => {
          const filePath = path.join(dir, name);
          await fs.writeFile(filePath, createSafeAudioFixtureBuffer());
          return { path: filePath, contentType: "audio/wav", workspaceDir: dir };
        }),
      );
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        tools: {
          media: {
            models: [
              {
                type: "cli",
                command: process.execPath,
                args: [
                  "-e",
                  `const fs = require("node:fs");
const name = require("node:path").basename(process.argv[1]);
fs.appendFileSync(process.argv[2], name + "\\n");
process.stdout.write(process.argv[3] === "empty" && name === "first.wav" ? "  \\n" : "heard " + name);`,
                  "{{AttachmentPath}}",
                  callsPath,
                  emptyFirst ? "empty" : "text",
                ],
                capabilities: ["audio"],
              },
            ],
            audio: { attachments },
          },
        },
      };
      const ctx: MsgContext = {
        Body: "",
        media: [{}, { ...media[0], transcribed: true }, ...media.slice(1)],
      };
      const transcript = await transcribeFirstAudio({ ctx, cfg });
      expect(transcript).toBe(emptyFirst ? undefined : "heard first.wav");
      expect(ctx.media?.map((fact) => fact.transcribed === true)).toEqual([
        false,
        true,
        !emptyFirst,
        false,
      ]);
      expect(await fs.readFile(callsPath, "utf8")).toBe("first.wav\n");

      ctx.Body = transcript ?? "";
      ctx.RawBody = transcript ?? "";
      ctx.CommandBody = transcript ?? "";
      await applyMediaUnderstanding({ ctx, cfg, workspaceDir: dir, processingMode: "audio-only" });

      expect(await fs.readFile(callsPath, "utf8")).toBe(
        emptyFirst ? "first.wav\nfirst.wav\nsecond.wav\n" : "first.wav\nsecond.wav\n",
      );
      expect(ctx.MediaUnderstanding).toEqual([
        expect.objectContaining({
          kind: "audio.transcription",
          attachmentIndex: 3,
          text: "heard second.wav",
        }),
      ]);
      expect(ctx.Body).toContain("heard second.wav");
      if (!emptyFirst) {
        expect(ctx.Body).toContain("heard first.wav");
      }
    });
  });
});
