import { describe, expect, it } from "vitest";
import {
  findMessagingTmpdirCallLines,
  messagingTmpdirGuardSourceRoots,
} from "../../scripts/check-no-random-messaging-tmp.mjs";

describe("check-no-random-messaging-tmp", () => {
  it("finds os.tmpdir calls imported from node:os", () => {
    const source = `
      import os from "node:os";
      const dir = os.tmpdir();
    `;
    expect(findMessagingTmpdirCallLines(source)).toEqual([3]);
  });

  it("finds tmpdir named import calls from node:os", () => {
    const source = `
      import { tmpdir } from "node:os";
      const dir = tmpdir();
    `;
    expect(findMessagingTmpdirCallLines(source)).toEqual([3]);
  });

  it("finds tmpdir calls imported from os", () => {
    const source = `
      import os from "os";
      const dir = os.tmpdir();
    `;
    expect(findMessagingTmpdirCallLines(source)).toEqual([3]);
  });

  it("ignores mentions in comments and strings", () => {
    const source = `
      // os.tmpdir()
      const text = "tmpdir()";
    `;
    expect(findMessagingTmpdirCallLines(source)).toStrictEqual([]);
  });

  it("ignores tmpdir symbols that are not imported from node:os", () => {
    const source = `
      const tmpdir = () => "/tmp";
      const dir = tmpdir();
    `;
    expect(findMessagingTmpdirCallLines(source)).toStrictEqual([]);
  });

  it("guards src/media against host tmpdir usage", () => {
    expect(messagingTmpdirGuardSourceRoots).toContain("src/media");
  });
});
