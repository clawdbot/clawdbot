import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { withRuntimeImageHistory } from "@openclaw/media-core";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  buildCliArgs,
  prepareCliPromptImagePayload,
  resolvePromptInput,
} from "./cli-runner/helpers.js";
import { detectAndLoadPromptImages } from "./embedded-agent-runner/run/images.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const QUESTION = "Describe the photo";
const NOTE = "[Recent image 1 from Ada, message retained, attached as media.]";
const CLI_PROBE = `
const fs = require("node:fs");
const crypto = require("node:crypto");
const args = process.argv.slice(1);
const images = [];
for (let i = 0; i < args.length; i += 2) {
  if (args[i] !== "--image") throw new Error("unexpected CLI argument");
  images.push(crypto.createHash("sha256").update(fs.readFileSync(args[i + 1])).digest("hex"));
}
process.stdout.write(JSON.stringify({ prompt: fs.readFileSync(0, "utf8"), images }));
`;

describe("CLI retained image input", () => {
  it.each([
    { kind: "retained", withLayout: true },
    { kind: "invalid", withLayout: true },
    { kind: "ordinary", withLayout: true },
    { kind: "retained", withLayout: false },
    { kind: "invalid", withLayout: false },
  ] as const)(
    "keeps the $kind image note consistent with the child input and files (layout=$withLayout)",
    async ({ kind, withLayout }) => {
      await withTestDir({ prefix: "openclaw-cli-history-input-" }, async (workspaceDir) => {
        const backend = {
          command: process.execPath,
          input: "stdin" as const,
          imageArg: "--image",
          imagePathScope: "workspace" as const,
        };
        const image = {
          type: "image" as const,
          mimeType: "image/png",
          data:
            kind === "invalid"
              ? (withLayout
                  ? Buffer.from("not an image")
                  : Buffer.from(PNG, "base64").subarray(0, 8)
                ).toString("base64")
              : PNG,
        };
        if (kind !== "ordinary") {
          withRuntimeImageHistory(image, {
            key: "retained",
            sourceText: "from Ada, message retained",
          });
        }
        if (!withLayout) {
          const validated = await detectAndLoadPromptImages({
            prompt: QUESTION,
            workspaceDir,
            model: { input: ["text", "image"] },
            existingImages: [image],
            imageOrder: ["inline"],
          });
          expect({
            images: validated.images.map((entry) =>
              createHash("sha256").update(Buffer.from(entry.data, "base64")).digest("hex"),
            ),
            failedMediaCount: validated.failedMediaCount,
          }).toEqual({
            images:
              kind === "invalid"
                ? []
                : [createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex")],
            failedMediaCount: 0,
          });
        }
        const prepared = await prepareCliPromptImagePayload({
          backend,
          prompt: QUESTION,
          workspaceDir,
          images: [image],
          ...(withLayout
            ? { mediaImageLayout: { slots: [{ kind: "inline" as const }] } }
            : { imageOrder: ["inline" as const] }),
        });
        try {
          const promptInput = resolvePromptInput({ backend, prompt: prepared.prompt });
          const args = buildCliArgs({
            backend,
            baseArgs: [],
            modelId: "image-fixture",
            useResume: false,
            promptArg: promptInput.argsPrompt,
            imagePaths: prepared.imagePaths,
          });
          const received: unknown = JSON.parse(
            execFileSync(process.execPath, ["-e", CLI_PROBE, "--", ...args], {
              input: promptInput.stdin,
              encoding: "utf8",
              timeout: 5_000,
            }),
          );
          const expectedPrompt = kind === "retained" ? `${QUESTION}\n\n${NOTE}` : QUESTION;
          expect(received).toEqual({
            prompt:
              kind === "invalid"
                ? expectedPrompt
                : `${expectedPrompt}\n\n${prepared.imagePaths?.join("\n")}`,
            images:
              kind === "invalid"
                ? []
                : [createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex")],
          });
        } finally {
          await prepared.cleanupImages?.();
        }
      });
    },
  );
});
