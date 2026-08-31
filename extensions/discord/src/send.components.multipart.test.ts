import fs from "node:fs/promises";
import path from "node:path";
import { MessageFlags } from "discord-api-types/v10";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import type { DiscordComponentMessageSpec } from "./components.js";
import { sendDiscordComponentMessage } from "./send.components.js";
import { createDiscordLoopbackRest } from "./send.test-harness.js";

const FILE_CONTENT = "%PDF-1.4\nDiscord attachment filename proof\n%%EOF\n";
const CASES: Array<{
  label: string;
  declaredName?: string;
  filename?: string;
  componentsV2?: boolean;
  expectedName: string;
}> = [
  { label: "classic declared name", declaredName: "report.pdf", expectedName: "report.pdf" },
  {
    label: "classic blank override",
    declaredName: "report.pdf",
    filename: "  ",
    expectedName: "report.pdf",
  },
  {
    label: "classic explicit override",
    declaredName: "report.pdf",
    filename: " operator.pdf ",
    expectedName: "operator.pdf",
  },
  { label: "classic media-derived name", expectedName: "source.pdf" },
  {
    label: "component declared name",
    declaredName: "report.pdf",
    componentsV2: true,
    expectedName: "report.pdf",
  },
];

describe("Discord component attachment multipart filenames", () => {
  it.each(CASES)("preserves $label at the HTTP boundary", async (testCase) => {
    await withTempHome(async (home) => {
      const mediaRoot = await fs.realpath(home);
      const mediaPath = path.join(mediaRoot, "source.pdf");
      await fs.writeFile(mediaPath, FILE_CONTENT);
      const loopback = await createDiscordLoopbackRest();
      try {
        const spec: DiscordComponentMessageSpec = {
          text: "See attached report",
          blocks: testCase.declaredName
            ? [{ type: "file", file: `attachment://${testCase.declaredName}` }]
            : [],
          ...(testCase.componentsV2 ? { container: { accentColor: 0x123456 } } : {}),
        };
        const result = await sendDiscordComponentMessage("channel:789", spec, {
          cfg: { channels: { discord: { token: "test-token" } } },
          token: "test-token",
          rest: loopback.rest,
          mediaUrl: mediaPath,
          mediaLocalRoots: [mediaRoot],
          filename: testCase.filename,
        });
        expect(result.messageId).toBe("loopback-message");
        const uploads = loopback.requests.filter((request) => request.method === "POST");
        expect(uploads).toHaveLength(1);
        const upload = uploads[0];
        expect(upload?.path).toBe("/v10/channels/789/messages");
        expect(upload?.contentType).toMatch(/^multipart\/form-data; boundary=/);
        const form = await new Response(upload?.body, {
          headers: { "content-type": upload?.contentType ?? "" },
        }).formData();
        const file = form.get("files[0]");
        if (!file || typeof file === "string") {
          throw new Error("Discord multipart request did not contain files[0]");
        }
        const payloadJson = form.get("payload_json");
        if (typeof payloadJson !== "string") {
          throw new Error("Discord multipart request did not contain string payload_json");
        }
        const payload = JSON.parse(payloadJson) as {
          attachments?: Array<{ id: number; filename: string }>;
          flags?: number;
        };
        process.stdout.write(
          `${JSON.stringify({
            case: testCase.label,
            filename: file.name,
            contentType: file.type,
            attachments: payload.attachments,
            componentsV2: Boolean((payload.flags ?? 0) & MessageFlags.IsComponentsV2),
          })}\n`,
        );
        expect(await file.text()).toBe(FILE_CONTENT);
        expect(file.type).toBe("application/pdf");
        expect(file.name).toBe(testCase.expectedName);
        expect(payload.attachments).toEqual([{ id: 0, filename: testCase.expectedName }]);
        expect(Boolean((payload.flags ?? 0) & MessageFlags.IsComponentsV2)).toBe(
          testCase.componentsV2 === true,
        );
      } finally {
        await loopback.close();
      }
    });
  });
});
