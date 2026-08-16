export const TSGO_CORE_TEST_MAX_ROOTS = 720;

export const TSGO_CORE_TEST_SHARDS = [
  {
    name: "agents-root",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.agents-root.json",
  },
  {
    name: "agents-other",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.agents-other.json",
  },
  {
    name: "gateway-root",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.gateway-root.json",
  },
  {
    name: "gateway-other",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.gateway-other.json",
  },
  { name: "infra", group: "src", config: "test/tsconfig/tsconfig.core.test.infra.json" },
  { name: "commands", group: "src", config: "test/tsconfig/tsconfig.core.test.commands.json" },
  {
    name: "plugins-platform",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.plugins-platform.json",
  },
  {
    name: "config-cli",
    group: "src",
    config: "test/tsconfig/tsconfig.core.test.config-cli.json",
  },
  { name: "messaging", group: "src", config: "test/tsconfig/tsconfig.core.test.messaging.json" },
  { name: "services", group: "src", config: "test/tsconfig/tsconfig.core.test.services.json" },
  { name: "other", group: "src", config: "test/tsconfig/tsconfig.core.test.other.json" },
  {
    name: "ui-pages-e2e",
    group: "ui",
    config: "test/tsconfig/tsconfig.core.test.ui-pages-e2e.json",
  },
  { name: "ui-other", group: "ui", config: "test/tsconfig/tsconfig.core.test.ui-other.json" },
  {
    name: "packages",
    group: "packages",
    config: "test/tsconfig/tsconfig.test.packages.json",
    sparseRoots: ["packages", "src", "ui/src"],
  },
] as const;

export type TsgoCoreTestShard = (typeof TSGO_CORE_TEST_SHARDS)[number];

export const TSGO_TARGETED_TEST_SHARED_SHARDS = [
  {
    name: "extension-declarations",
    config: "test/tsconfig/tsconfig.test.extension-declarations.json",
    sparseRoots: ["extensions", "src", "ui/src"],
  },
] as const;

export function selectTsgoCoreTestShards(
  requestedGroup?: string,
): readonly { name: string; config: string }[] | undefined {
  if (!requestedGroup) {
    return TSGO_CORE_TEST_SHARDS;
  }
  const selected = TSGO_CORE_TEST_SHARDS.filter((shard) => shard.group === requestedGroup);
  if (selected.length === 0) {
    return undefined;
  }
  // Targeted aliases historically checked extension declarations as shared ambient input.
  return [...selected, ...TSGO_TARGETED_TEST_SHARED_SHARDS];
}

/**
 * Deterministic round-robin stripe over the full shard list for CI-level
 * parallelism. Shard walls are near-uniform, so index striping stays balanced
 * as shards are added; the union across stripes is exactly the full list.
 */
export function selectTsgoCoreTestStripe(
  stripeSpec: string,
): readonly { name: string; config: string }[] | undefined {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(stripeSpec);
  if (!match) {
    return undefined;
  }
  const stripe = Number(match[1]);
  const stripeCount = Number(match[2]);
  if (stripe > stripeCount) {
    return undefined;
  }
  return TSGO_CORE_TEST_SHARDS.filter((_, index) => index % stripeCount === stripe - 1);
}

export function findTsgoCoreTestShardViolations(params: {
  canonicalRoots: readonly string[];
  maxRoots?: number;
  shards: readonly { name: string; roots: readonly string[] }[];
}): string[] {
  const maxRoots = params.maxRoots ?? TSGO_CORE_TEST_MAX_ROOTS;
  const canonical = new Set(params.canonicalRoots);
  const owners = new Map<string, string[]>();
  const violations: string[] = [];

  for (const shard of params.shards) {
    if (shard.roots.length > maxRoots) {
      violations.push(
        `${shard.name}: ${shard.roots.length} test roots exceeds the ${maxRoots} limit`,
      );
    }
    for (const root of shard.roots) {
      const rootOwners = owners.get(root) ?? [];
      rootOwners.push(shard.name);
      owners.set(root, rootOwners);
    }
  }

  for (const root of canonical) {
    const rootOwners = owners.get(root) ?? [];
    if (rootOwners.length === 0) {
      violations.push(`unassigned: ${root}`);
    } else if (rootOwners.length > 1) {
      violations.push(`assigned ${rootOwners.length} times (${rootOwners.join(", ")}): ${root}`);
    }
  }
  for (const [root, rootOwners] of owners) {
    if (!canonical.has(root)) {
      violations.push(`not in the canonical core-test graph (${rootOwners.join(", ")}): ${root}`);
    }
  }

  return violations;
}
