// Media Understanding Common helper module supports format behavior.
import type { MediaUnderstandingOutput } from "./types.js";

function formatSection(
  title: string,
  kind: "Transcript" | "Description",
  text: string,
  userText?: string,
): string {
  const lines = [`[${title}]`];
  if (userText) {
    lines.push(`User text:\n${userText}`);
  }
  lines.push(`${kind}:\n${text}`);
  return lines.join("\n");
}

/** Formats media-understanding outputs into the chat body sent back to the model. */
export function formatMediaUnderstandingBody(params: {
  body?: string;
  outputs: MediaUnderstandingOutput[];
}): string {
  const outputs = params.outputs.filter((output) => output.text.trim());
  if (outputs.length === 0) {
    return params.body ?? "";
  }

  const userText = params.body?.trim() || undefined;
  const sections: string[] = [];
  if (userText && outputs.length > 1) {
    sections.push(`User text:\n${userText}`);
  }

  const counts = new Map<MediaUnderstandingOutput["kind"], number>();
  for (const output of outputs) {
    counts.set(output.kind, (counts.get(output.kind) ?? 0) + 1);
  }
  const seen = new Map<MediaUnderstandingOutput["kind"], number>();

  for (const output of outputs) {
    const count = counts.get(output.kind) ?? 1;
    const next = (seen.get(output.kind) ?? 0) + 1;
    seen.set(output.kind, next);
    const suffix = count > 1 ? ` ${next}/${count}` : "";
    if (output.kind === "audio.transcription") {
      sections.push(
        formatSection(
          `Audio${suffix}`,
          "Transcript",
          output.text,
          outputs.length === 1 ? userText : undefined,
        ),
      );
      continue;
    }
    if (output.kind === "image.description") {
      sections.push(
        formatSection(
          `Image${suffix}`,
          "Description",
          output.text,
          outputs.length === 1 ? userText : undefined,
        ),
      );
      continue;
    }
    sections.push(
      formatSection(
        `Video${suffix}`,
        "Description",
        output.text,
        outputs.length === 1 ? userText : undefined,
      ),
    );
  }

  return sections.join("\n\n").trim();
}

/** Formats one or more audio transcript outputs for legacy transcript-only callers. */
export function formatAudioTranscripts(outputs: MediaUnderstandingOutput[]): string {
  if (outputs.length === 1) {
    const [output] = outputs;
    if (output) {
      return output.text;
    }
    throw new Error("expected single audio transcript to be defined");
  }
  return outputs.map((output, index) => `Audio ${index + 1}:\n${output.text}`).join("\n\n");
}
