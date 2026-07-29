/**
 * Shared assertions for channel pairing reply text.
 */
import { expect } from "vitest";

/** Extracts and asserts the pairing code block from a pairing reply. */
export function extractPairingCode(text: string): string {
  const code = text.match(/Pairing code:\s*```[\r\n]+([A-Z2-9]{6,})/)?.[1];
  expect(code).toBeDefined();
  return code ?? "";
}

/** Verifies the visible pairing reply contains the expected id and approve command. */
export function expectPairingReplyText(
  text: string,
  params: {
    channel: string;
    idLine: string;
    code?: string;
  },
): string {
  const code = params.code ?? extractPairingCode(text);
  expect(text).toContain("OpenClaw: access not configured.");
  expect(text).toContain(params.idLine);
  expect(text).toContain("Pairing code:");
  expect(text).toContain(`\n\`\`\`\n${code}\n\`\`\`\n`);
  expect(text).toContain(`pairing approve ${params.channel} ${code}`);
  return code;
}
