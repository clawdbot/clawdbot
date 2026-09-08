import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("auth rotation config", () => {
  it.each([undefined, {}, { onCompaction: true }, { onCompaction: false }])(
    "accepts optional per-provider compaction rotation: %j",
    (policy) => {
      const auth = policy === undefined ? {} : { rotation: { openai: policy } };
      expect(OpenClawSchema.parse({ auth }).auth).toEqual(auth);
    },
  );

  it.each([{ onCompaction: "false" }, { onCompaction: 0 }, { unknown: false }])(
    "rejects invalid rotation policy: %j",
    (policy) => {
      expect(OpenClawSchema.safeParse({ auth: { rotation: { openai: policy } } }).success).toBe(
        false,
      );
    },
  );
});
