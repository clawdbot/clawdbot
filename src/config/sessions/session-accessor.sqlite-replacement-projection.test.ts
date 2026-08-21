import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";

const { readExactSessionEntryJsonMock } = vi.hoisted(() => ({
  readExactSessionEntryJsonMock: vi.fn(),
}));

vi.mock("./session-accessor.sqlite-entry-store.js", async () => {
  const actual = await vi.importActual<typeof import("./session-accessor.sqlite-entry-store.js")>(
    "./session-accessor.sqlite-entry-store.js",
  );
  readExactSessionEntryJsonMock.mockImplementation(actual.readExactSessionEntryJson);
  return { ...actual, readExactSessionEntryJson: readExactSessionEntryJsonMock };
});

const { applySessionEntryReplacements, loadSessionEntry, upsertSessionEntryCore } =
  await import("./session-accessor.js");

describe("session entry replacement compare-and-swap", () => {
  const tempDirs: string[] = [];
  let storePath: string;

  beforeEach(() => {
    storePath = `${makeTempDir(tempDirs, "replacement-cas")}/openclaw-agent.sqlite`;
  });

  afterEach(() => {
    readExactSessionEntryJsonMock.mockReset();
    cleanupTempDirs(tempDirs);
  });

  it("refuses to replace a selected row whose bytes disappear before the snapshot completes", async () => {
    const scope = { sessionKey: "agent:main:vanishing-row", storePath };
    await upsertSessionEntryCore(scope, {
      model: "base",
      sessionId: "vanishing-row",
      updatedAt: 10,
    });
    // A concurrent writer can delete the row between hydrating the snapshot entry and reading
    // its persisted bytes. Both the snapshot and the transaction then observe "no bytes", so a
    // missing-vs-missing compare would agree and rewrite the stale entry into the deleted key.
    readExactSessionEntryJsonMock.mockReturnValue(undefined);

    await expect(
      applySessionEntryReplacements({
        sessionKeys: [scope.sessionKey],
        storePath,
        update: (entries) => ({
          replacements: entries.map(({ entry, sessionKey }) => ({
            entry: { ...entry, model: "resurrected" },
            sessionKey,
          })),
          result: undefined,
        }),
      }),
    ).rejects.toThrow("changed before replacement");

    expect(loadSessionEntry(scope)).toMatchObject({ model: "base", sessionId: "vanishing-row" });
  });
});
