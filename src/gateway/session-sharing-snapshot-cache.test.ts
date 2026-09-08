import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invalidateSessionSharingSnapshot,
  loadCachedSessionSharingSnapshot,
  type SessionSharingSnapshot,
} from "./session-sharing-snapshot-cache.js";

const snapshot: SessionSharingSnapshot = { incognito: false, visibility: "shared" };

function loadSnapshot(params: { alias: string; canonical: string; resolve: () => void }) {
  return loadCachedSessionSharingSnapshot({
    sessionKey: params.alias,
    resolve: () => {
      params.resolve();
      return { canonicalKey: params.canonical, snapshot };
    },
  });
}

afterEach(() => {
  invalidateSessionSharingSnapshot();
});

describe("session sharing snapshot reverse indexes", () => {
  it.each(["canonical", "alias-one"])(
    "invalidates canonical and alias entries loaded as %s",
    (alias) => {
      const first = vi.fn();
      const second = vi.fn();
      loadSnapshot({ alias, canonical: "canonical", resolve: first });
      loadSnapshot({ alias: "alias-two", canonical: "canonical", resolve: second });
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();

      loadSnapshot({ alias: "alias-two", canonical: "canonical", resolve: second });
      expect(second).toHaveBeenCalledOnce();
      invalidateSessionSharingSnapshot("canonical");
      loadSnapshot({ alias: "alias-two", canonical: "canonical", resolve: second });
      expect(second).toHaveBeenCalledTimes(2);
    },
  );

  it("invalidating one alias removes its canonical entry and sibling aliases", () => {
    const first = vi.fn();
    const second = vi.fn();
    loadSnapshot({ alias: "alias-one", canonical: "canonical", resolve: first });
    loadSnapshot({ alias: "alias-two", canonical: "canonical", resolve: second });

    invalidateSessionSharingSnapshot("alias-one");
    loadSnapshot({ alias: "alias-two", canonical: "canonical", resolve: second });
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("keeps reverse indexes consistent across canonical eviction and alias reuse", () => {
    const oldAlias = vi.fn();
    loadSnapshot({ alias: "reused-alias", canonical: "old-canonical", resolve: oldAlias });
    for (let index = 0; index < 2_048; index += 1) {
      loadSnapshot({
        alias: index % 2 === 0 ? `canonical-${index}` : `alias-${index}`,
        canonical: `canonical-${index}`,
        resolve: vi.fn(),
      });
    }

    const newAlias = vi.fn();
    loadSnapshot({ alias: "reused-alias", canonical: "new-canonical", resolve: newAlias });
    expect(newAlias).toHaveBeenCalledOnce();
    invalidateSessionSharingSnapshot("old-canonical");
    loadSnapshot({ alias: "reused-alias", canonical: "new-canonical", resolve: newAlias });
    expect(newAlias).toHaveBeenCalledOnce();

    invalidateSessionSharingSnapshot("reused-alias");
    loadSnapshot({ alias: "reused-alias", canonical: "new-canonical", resolve: newAlias });
    expect(newAlias).toHaveBeenCalledTimes(2);
  });
});
