import { describe, expect, it, vi } from "vitest";
import { emitDoctorNotes } from "./emit-notes.js";

describe("doctor note emission", () => {
  it("emits grouped change and warning notes with the correct titles", () => {
    const note = vi.fn();

    emitDoctorNotes({
      note,
      changeNotes: ["change one", "change two"],
      warningNotes: ["warning one"],
    });

    expect(note.mock.calls).toEqual([
      ["change one", "Doctor changes"],
      ["change two", "Doctor changes"],
      ["warning one", "Doctor warnings"],
    ]);
  });

  it("emits only warning notes when changeNotes is omitted", () => {
    const note = vi.fn();

    emitDoctorNotes({
      note,
      warningNotes: ["warning only"],
    });

    expect(note.mock.calls).toEqual([["warning only", "Doctor warnings"]]);
  });

  it("sanitizes emitted notes from plugin-provided doctor output", () => {
    const note = vi.fn();

    emitDoctorNotes({
      note,
      changeNotes: ["change \u001B[31mred\u001B[0m\nnext line"],
      warningNotes: [
        `warning \u001B]8;;https://example.test\u001B\\link\u001B]8;;\u001B\\${String.fromCharCode(
          0x9b,
        )}\r`,
      ],
    });

    expect(note.mock.calls).toEqual([
      ["change red\nnext line", "Doctor changes"],
      ["warning link", "Doctor warnings"],
    ]);
  });

  it("emits nothing when note groups are omitted or empty", () => {
    const note = vi.fn();

    emitDoctorNotes({ note });
    emitDoctorNotes({ note, changeNotes: [], warningNotes: [] });

    expect(note).not.toHaveBeenCalled();
  });
});
