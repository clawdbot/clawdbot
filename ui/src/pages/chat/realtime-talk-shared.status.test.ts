import { describe, expect, it } from "vitest";
import { t } from "../../i18n/index.ts";
import { realtimeTalkStatusDetail } from "./realtime-talk-shared.ts";

describe("Talk status detail projection", () => {
  it.each(["idle", "connecting", "error"] as const)(
    "preserves %s without an active identity",
    (status) => {
      expect(realtimeTalkStatusDetail(status, null, "Call identity")).toBeNull();
      expect(realtimeTalkStatusDetail(status, "Operator detail", "Call identity")).toBe(
        "Operator detail",
      );
    },
  );

  it.each(["listening", "thinking"] as const)(
    "keeps the localized %s status beside confirmed identity",
    (status) => {
      const label = t(status === "thinking" ? "chat.voice.asking" : "chat.voice.listening");
      expect(realtimeTalkStatusDetail(status, null, "Call identity")).toBe(
        label + " — Call identity",
      );
      expect(realtimeTalkStatusDetail(status, null, null)).toBe(label);
      expect(realtimeTalkStatusDetail(status, "Operator detail", "Call identity")).toBe(
        "Operator detail — Call identity",
      );
    },
  );

  it("preserves explicit empty detail rather than inventing a fallback", () => {
    expect(realtimeTalkStatusDetail("listening", "", "Call identity")).toBe("Call identity");
    expect(realtimeTalkStatusDetail("thinking", "", null)).toBeNull();
  });
});
