/**
 * EMPIRICAL orphan-proof for the #978/#3 leaf-key-vs-parent-key layer-question.
 *
 * The dispute (2026-06-09 lag-storm): a deny-tools/light-context leaf emitting
 * `[[CONTINUE_DELEGATE: ... | post-compaction]]` — should the staged delegate be
 * keyed under the LEAF's own sessionKey (in-turn, "mirror tool :235") or the
 * PARENT's requesterSessionKey (announce-path, `855fa37`'s :996)?
 *
 * Camp-in-turn (🌊): "stage under leaf-key in-turn; the leaf's own next
 *   compaction consumes it; no orphan."
 * Camp-parent-key (🌿 + 🩸): "the deny-tools leaf is one-shot, emits the bracket
 *   as its response-tail, never compacts before :1511 deletes it → leaf-key
 *   orphans; only the long-lived parent reliably compacts + consumes."
 *
 * This test settles it EMPIRICALLY against the real delegate-store, with NO
 * source-reading. It proves the store is strictly KEYED: a delegate staged under
 * key-A is invisible to consume(key-B), and nothing migrates leaf→parent. So a
 * leaf that never compacts (light-context) and is then deleted leaves the
 * delegate with NO surviving consumer = orphan.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  stagePostCompactionDelegate,
  consumeStagedPostCompactionDelegates,
  stagedPostCompactionDelegateCount,
} from "../continuation/delegate-store.js";

describe("EMPIRICAL :: leaf-key post-compaction stage orphans when the leaf never compacts", () => {
  const leafKey = "leaf-session::oneshot-deny-tools";
  const parentKey = "parent-session::live-requester";

  beforeEach(() => {
    // Clean both lanes.
    consumeStagedPostCompactionDelegates(leafKey);
    consumeStagedPostCompactionDelegates(parentKey);
  });

  it("a leaf-key staged delegate is INVISIBLE to the parent's consume (strict keying)", () => {
    // In-turn camp's design: stage under the leaf's own key.
    stagePostCompactionDelegate(leafKey, {
      task: "leaf lifeboat",
      createdAt: 1_700_000_000_000,
    });
    expect(stagedPostCompactionDelegateCount(leafKey)).toBe(1);

    // The parent — the only session that survives the leaf's :1511 deletion —
    // cannot see or consume a delegate keyed to the leaf.
    expect(stagedPostCompactionDelegateCount(parentKey)).toBe(0);
    const parentConsumed = consumeStagedPostCompactionDelegates(parentKey);
    expect(parentConsumed).toHaveLength(0);

    // The leaf's delegate is still stranded under the leaf key (nobody else
    // could take it).
    expect(stagedPostCompactionDelegateCount(leafKey)).toBe(1);
  });

  it("ORPHAN: leaf never compacts (no consume on leafKey) + leaf deleted → delegate stranded, never fires", () => {
    // 1. Leaf stages in-turn under its own key.
    stagePostCompactionDelegate(leafKey, {
      task: "leaf lifeboat (in-turn)",
      createdAt: 1_700_000_000_000,
    });
    expect(stagedPostCompactionDelegateCount(leafKey)).toBe(1);

    // 2. A light-context one-shot leaf NEVER compacts → the post-compaction
    //    release lifecycle (which is the ONLY caller of
    //    consumeStagedPostCompactionDelegates(leafKey)) never fires for it.
    //    We model "leaf is deleted at :1511" as: the leaf key is simply gone —
    //    no further consume(leafKey) will ever be issued by the runtime.
    //
    //    The delegate remains staged. It is now an orphan: there is no surviving
    //    session whose compaction will consume the leaf-keyed flow.
    expect(stagedPostCompactionDelegateCount(leafKey)).toBe(1);
    expect(stagedPostCompactionDelegateCount(parentKey)).toBe(0);

    // 3. Contrast: the parent-key design. Stage the SAME lifeboat under the
    //    live parent. The parent survives + compacts → its release consumes it.
    stagePostCompactionDelegate(parentKey, {
      task: "leaf lifeboat (parent-keyed, 855fa37 :996)",
      createdAt: 1_700_000_000_000,
    });
    const parentFired = consumeStagedPostCompactionDelegates(parentKey);
    expect(parentFired).toHaveLength(1);
    expect(parentFired[0]).toMatchObject({
      task: "leaf lifeboat (parent-keyed, 855fa37 :996)",
    });

    // The parent-keyed lifeboat fired; the leaf-keyed one is still stranded.
    expect(stagedPostCompactionDelegateCount(leafKey)).toBe(1);
  });

  it("no migration: deleting/cleaning the leaf lane does NOT move its delegate to the parent", () => {
    stagePostCompactionDelegate(leafKey, {
      task: "leaf lifeboat",
      createdAt: 1_700_000_000_000,
    });
    // Whatever the announce-flow does to the leaf's lane at completion, the
    // parent lane stays empty unless something is EXPLICITLY staged under the
    // parent key. (855fa37 re-parses the bracket and stages under the parent;
    // there is no leaf→parent migration of an already-leaf-staged delegate.)
    expect(stagedPostCompactionDelegateCount(parentKey)).toBe(0);

    // Simulate the leaf lane being drained at deletion (cleanup) — the parent
    // gains nothing.
    consumeStagedPostCompactionDelegates(leafKey); // leaf gone
    expect(stagedPostCompactionDelegateCount(parentKey)).toBe(0);
  });
});
