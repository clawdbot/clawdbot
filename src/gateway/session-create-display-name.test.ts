import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "./session-create-service.js";

describe("session creation display titles", () => {
  it.each([
    { kind: "trimmed", title: "  Native title  ", expected: "Native title" },
    { kind: "empty", title: "", expected: undefined },
    { kind: "blank", title: " \n\t ", expected: undefined },
    { kind: "long", title: ` ${"x".repeat(600)} `, expected: "x".repeat(500) },
    {
      kind: "split surrogate",
      title: ` ${"界".repeat(499)}${"🦞".repeat(300)} `,
      expected: "界".repeat(499),
    },
    { kind: "whole surrogates", title: "🦞".repeat(300), expected: "🦞".repeat(250) },
  ])("bounds a create-only $kind title snapshot", async ({ title, expected }) => {
    await withOpenClawTestState({ label: "create-display-title" }, async () => {
      const first = await createGatewaySession({
        cfg: {},
        key: "agent:main:title-first",
        displayName: title,
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
      });
      const second = await createGatewaySession({
        cfg: {},
        key: "agent:main:title-second",
        displayName: title,
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
      });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) {
        throw new Error("Display titles must not reject session creation");
      }
      expect(first.entry.displayName).toBe(expected);
      expect(second.entry.displayName).toBe(expected);
      expect(first.entry.label).toBeUndefined();
      expect(second.entry.label).toBeUndefined();
      expect(first.entry.sessionId).not.toBe(second.entry.sessionId);

      const repeated = await createGatewaySession({
        cfg: {},
        key: first.key,
        displayName: "Do not overwrite or backfill existing rows",
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
      });
      expect(repeated).toMatchObject({
        ok: true,
        entry: { sessionId: first.entry.sessionId },
      });
      if (!repeated.ok) {
        throw new Error(repeated.error.message);
      }
      expect(repeated.entry.displayName).toBe(expected);
    });
  });

  it("preserves explicit labels and still rejects equivalent duplicate labels", async () => {
    await withOpenClawTestState({ label: "create-title-with-label" }, async () => {
      const create = (key: string, label: string) =>
        createGatewaySession({
          cfg: {},
          key,
          label,
          displayName: "Non-unique native title",
          commandSource: "test",
          operatorRoleActor: { kind: "system" },
        });
      const first = await create("agent:main:operator-first", "Operator label");
      expect(first).toMatchObject({
        ok: true,
        entry: { label: "Operator label", displayName: "Non-unique native title" },
      });
      await expect(
        create("agent:main:operator-second", "  Operator label  "),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "label already in use: Operator label" },
      });
    });
  });
});
