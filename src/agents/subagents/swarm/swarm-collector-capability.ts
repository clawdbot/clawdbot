import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  bindAgentToolAvailability,
  getAgentToolAvailabilityBinding,
  type AgentToolAvailabilityBinding,
} from "../../agent-tool-availability.js";
import { SESSIONS_SPAWN_COLLECTOR_GUIDANCE } from "../../tool-description-presets.js";
import { filterRuntimeCompatibleTools } from "../../tool-schema-projection.js";
import { ToolInputError, type AnyAgentTool } from "../../tools/common.js";

const COLLECTOR_FIELDS = ["collect", "outputSchema", "groupId"] as const;
const WAIT_GUIDANCE = SESSIONS_SPAWN_COLLECTOR_GUIDANCE.replace(
  /\.$/u,
  "; await with agents_wait.",
);
const readerBinding: AgentToolAvailabilityBinding = { prepare() {} };
type SpawnCapability = {
  nativeReader: object | undefined;
  signal?: AbortSignal;
};
const spawnCapabilities = new WeakMap<AgentToolAvailabilityBinding, SpawnCapability>();
type JoinedSpawn = {
  owner: AgentToolAvailabilityBinding;
  assertCurrent: () => void;
  active: boolean;
  toolCallId?: string;
  claimed: boolean;
};
const joinedSpawns = new AsyncLocalStorage<JoinedSpawn>();

export function markCollectorReaderTool<T extends AnyAgentTool>(tool: T): T {
  return bindAgentToolAvailability(tool, readerBinding);
}

function collectorSchema(
  schema: unknown,
  fields: Record<string, unknown>,
): AnyAgentTool["parameters"] {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    throw new ToolInputError("Collector spawn schema is unavailable.");
  }
  const previousProperties = schema.properties;
  if (COLLECTOR_FIELDS.every((field) => previousProperties[field] === fields[field])) {
    return schema;
  }
  const properties = { ...previousProperties };
  for (const field of COLLECTOR_FIELDS) {
    delete properties[field];
  }
  return { ...schema, properties: { ...properties, ...fields } };
}

export function bindCollectorSpawnTool<T extends AnyAgentTool>(
  tool: T,
  properties: Record<string, unknown>,
  signal?: AbortSignal,
): T {
  const fields = Object.fromEntries(
    COLLECTOR_FIELDS.filter((field) => field in properties).map((field) => [
      field,
      properties[field],
    ]),
  );
  const capability: SpawnCapability = { nativeReader: undefined, signal };
  const binding: AgentToolAvailabilityBinding = {
    prepare(current, callableTools) {
      const reader = callableTools.get("agents_wait");
      capability.nativeReader =
        reader &&
        getAgentToolAvailabilityBinding(reader) === readerBinding &&
        filterRuntimeCompatibleTools([reader]).tools.length === 1
          ? reader
          : undefined;
      current.parameters = collectorSchema(
        current.parameters,
        capability.nativeReader ? fields : {},
      );
      const description = current.description
        .replace(WAIT_GUIDANCE, "")
        .replace(SESSIONS_SPAWN_COLLECTOR_GUIDANCE, "")
        .trim();
      current.description =
        capability.nativeReader && Object.keys(fields).length > 0
          ? `${description} ${WAIT_GUIDANCE}`
          : description;
    },
    executionSchema(currentSchema) {
      const joined = joinedSpawns.getStore();
      if (joined?.owner !== binding) {
        return currentSchema;
      }
      assertJoinedSpawn(joined);
      return collectorSchema(currentSchema, fields);
    },
  };
  spawnCapabilities.set(binding, capability);
  bindAgentToolAvailability(tool, binding);
  binding.prepare(tool, new Map());
  return tool;
}

export function isCollectorSpawnTool(tool: object): tool is AnyAgentTool {
  const binding = getAgentToolAvailabilityBinding(tool);
  return binding !== undefined && spawnCapabilities.has(binding);
}

function assertJoinedSpawn(joined: JoinedSpawn): void {
  if (!joined.active) {
    throw new ToolInputError("Joined collector spawn is no longer active.");
  }
  joined.assertCurrent();
}

/** One lexical joined call; neither replay metadata nor guest input can mint it. */
export async function runWithJoinedCollectorSpawn<T>(
  tool: object,
  assertCurrent: () => void,
  run: () => Promise<T>,
): Promise<T> {
  const owner = getAgentToolAvailabilityBinding(tool);
  if (!owner || !spawnCapabilities.has(owner)) {
    throw new ToolInputError("agents.run requires the native collector spawn tool.");
  }
  const joined: JoinedSpawn = { owner, assertCurrent, active: true, claimed: false };
  return await joinedSpawns.run(joined, async () => {
    try {
      assertJoinedSpawn(joined);
      return await run();
    } finally {
      joined.active = false;
    }
  });
}

/** Bind the private context to the catalog's exact invocation before awaited hooks. */
export function bindJoinedCollectorInvocation(tool: object, toolCallId: string): void {
  const joined = joinedSpawns.getStore();
  if (!joined || joined.owner !== getAgentToolAvailabilityBinding(tool)) {
    return;
  }
  assertJoinedSpawn(joined);
  if (joined.toolCallId !== undefined) {
    throw new ToolInputError("Joined collector spawn already has an invocation.");
  }
  joined.toolCallId = toolCallId;
}

export function captureCollectorSpawnGuard(
  tool: object,
  toolCallId: string,
  assertActive: () => void,
): () => void {
  const owner = getAgentToolAvailabilityBinding(tool);
  const capability = owner && spawnCapabilities.get(owner);
  const joined = joinedSpawns.getStore();
  if (joined && joined.owner === owner && joined.toolCallId === toolCallId) {
    assertJoinedSpawn(joined);
    if (joined.claimed) {
      throw new ToolInputError("Joined collector spawn was already claimed.");
    }
    joined.claimed = true;
    return () => {
      assertActive();
      capability?.signal?.throwIfAborted();
      assertJoinedSpawn(joined);
    };
  }
  return () => {
    assertActive();
    capability?.signal?.throwIfAborted();
    if (!capability?.nativeReader) {
      throw new ToolInputError(
        "Collector results are unavailable in this tool surface. Omit collect, outputSchema, and groupId to start an ordinary announcing child.",
      );
    }
  };
}
