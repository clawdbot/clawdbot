// Shared cycle detection for `preferOver` channel-ownership contests.

/**
 * Collects the groups of channel claimants whose `preferOver` declarations form a cycle.
 *
 * `preferOver` settles a channel contest by displacement: plugin A declaring `preferOver: [B]`
 * means A displaces B on a channel they both claim. Declarations that chase each other around a
 * ring — a→b, b→c, c→a — settle nothing: every member both displaces and is displaced, so no
 * member outranks another. The reciprocal-pair rule (A names B and B names A) is the accepted
 * 2-member case of exactly this; a longer ring satisfies neither direction of that check, so every
 * member gets displaced and the schema plane and the runtime plane pick different owners. Both
 * displacement sites call this function so they recognize the same rings.
 *
 * In graph terms the result is the multi-member strongly-connected components of the directed
 * preference graph over `nodes`:
 * - An edge whose target is not present in `nodes` is ignored. A non-declarant has no out-edges
 *   here and cannot sit on a cycle of this contest.
 * - Single-node components are omitted, and a self-edge declares nothing, so it never produces a
 *   component either.
 * - Duplicate ids in `nodes` and duplicate edges are tolerated.
 *
 * Determinism: components and their members are ordered by first occurrence in `nodes`, never by
 * Set/Map iteration accidents, so repeated calls over the same input agree — callers surface these
 * groups in diagnostics and must not flap between runs.
 *
 * Deliberately O(V·(V+E)): per-node reachability, then grouping by mutual reachability. The graph
 * is the claimant set of a single channel — typically 2 to 4 nodes — so a Tarjan-style linear pass
 * would buy nothing measurable and cost the reader the direct "mutually reachable" reading of the
 * contract above. Keep it this way.
 *
 * Leaf module by design: it imports nothing from the codebase, so it can never participate in an
 * import cycle no matter which side of the config/runtime boundary calls it.
 */
export function collectPreferenceCycleComponents(
  nodes: readonly string[],
  edgesOf: (nodeId: string) => readonly string[],
): string[][] {
  // First occurrence in `nodes` is the stable order every result below derives from.
  const order: string[] = [];
  const known = new Set<string>();
  for (const node of nodes) {
    if (!known.has(node)) {
      known.add(node);
      order.push(node);
    }
  }

  // Everything reachable from `start` through at least one edge, restricted to the supplied node
  // set. Traversal order does not matter here — only the resulting sets do — so a simple worklist
  // suffices. `start` itself appears in its own set exactly when some path loops back to it.
  const reachByNode = new Map<string, Set<string>>();
  for (const start of order) {
    const reached = new Set<string>();
    const pending: string[] = [start];
    for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
      for (const target of edgesOf(current)) {
        if (!known.has(target) || reached.has(target)) {
          continue;
        }
        reached.add(target);
        pending.push(target);
      }
    }
    reachByNode.set(start, reached);
  }

  // Two nodes share a cycle exactly when each reaches the other. Walking seeds in input order and
  // filtering members in input order keeps both orderings stable; marking every member grouped
  // stops the same component from re-emitting under a later seed.
  const grouped = new Set<string>();
  const components: string[][] = [];
  for (const seed of order) {
    if (grouped.has(seed)) {
      continue;
    }
    const seedReach = reachByNode.get(seed);
    if (seedReach === undefined || !seedReach.has(seed)) {
      // No path returns to this node, so it shares a cycle with nobody.
      continue;
    }
    const members = order.filter((member) => {
      const memberReach = reachByNode.get(member);
      return seedReach.has(member) && memberReach !== undefined && memberReach.has(seed);
    });
    if (members.length < 2) {
      // A lone self-edge reaches itself but declares nothing.
      continue;
    }
    for (const member of members) {
      grouped.add(member);
    }
    components.push(members);
  }
  return components;
}
