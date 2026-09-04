import { expect } from "vitest";

const overlongUnicode = (unit: string, maxLength: number) => `${unit.repeat(maxLength - 1)}🦞tail`;

export const adversarialResolved = {
  modelProvider: overlongUnicode("界", 48),
  model: overlongUnicode("模", 96),
  agentRuntime: {
    id: overlongUnicode("運", 48),
    fallback: "openclaw" as const,
    source: "session-key" as const,
  },
  thinkingLevel: overlongUnicode("考", 16),
  thinkingLevels: Array.from({ length: 12 }, (_, index) => ({
    id: `${index}:${overlongUnicode("識", 12)}`,
    label: `${index}:${overlongUnicode("思", 16)}`,
  })),
};

const escapedControlText = "\0".repeat(10_000);
export const escapeHeavyResolved = {
  modelProvider: escapedControlText,
  model: escapedControlText,
  agentRuntime: {
    id: escapedControlText,
    fallback: "none" as const,
    source: "provider" as const,
  },
  thinkingLevel: escapedControlText,
  thinkingLevels: Array.from({ length: 12 }, (_, index) => ({
    id: `${index}:${escapedControlText}`,
    label: `${index}:${escapedControlText}`,
  })),
};

export const expectedResolvedOmission = { reason: "response_budget_exceeded" } as const;

export function expectExactResolvedAcknowledgement(
  result: { content: Array<{ type: string; text?: string }>; details: unknown },
  expectedResolved: unknown,
) {
  expect((result.details as { resolved?: unknown }).resolved).toEqual(expectedResolved);
  const text = result.content[0]?.text ?? "";
  expect(JSON.parse(text)).toEqual(result.details);
  expect(text).not.toContain('"entry"');
  expect(text).not.toContain('"path"');
  expect(text).not.toContain("skillsSnapshot");
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(3_840);
}

export function expectOmittedResolvedAcknowledgement(result: {
  content: Array<{ type: string; text?: string }>;
  details: unknown;
}) {
  expect(result.details).toMatchObject({ resolvedOmitted: expectedResolvedOmission });
  expect((result.details as { resolved?: unknown }).resolved).toBeUndefined();
  const text = result.content[0]?.text ?? "";
  expect(JSON.parse(text)).toEqual(result.details);
  expect(text).not.toContain('"entry"');
  expect(text).not.toContain('"path"');
  expect(text).not.toContain("skillsSnapshot");
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(3_840);
}
