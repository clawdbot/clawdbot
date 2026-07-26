import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { ROUTING_MATCH_KINDS } from "../policy-routing.js";
import { policyShapeFinding, unsupportedPolicyKey } from "./shape-helpers.js";
import { ocPathSegment } from "./utils.js";

type ShapeContext = {
  readonly policyPath: string;
  readonly policyDocName: string;
};

export function routingPolicyShapeFinding(
  value: unknown,
  ctx: ShapeContext,
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return invalid(ctx, "routing", "routing must be an object.");
  }
  const unknown = unsupportedPolicyKey(value, [
    "probes",
    "requireBindings",
    "requireConfiguredChannels",
  ]);
  if (unknown !== undefined) {
    return invalid(
      ctx,
      `routing/${ocPathSegment(unknown)}`,
      `routing.${unknown} is not supported.`,
    );
  }
  for (const key of ["requireBindings", "requireConfiguredChannels"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      return invalid(ctx, `routing/${key}`, `routing.${key} must be a boolean.`);
    }
  }
  if (value.probes === undefined) {
    return undefined;
  }
  if (!Array.isArray(value.probes)) {
    return invalid(ctx, "routing/probes", "routing.probes must be an array.");
  }
  const ids = new Set<string>();
  for (const [index, probe] of value.probes.entries()) {
    const target = `routing/probes/#${index}`;
    if (!isRecord(probe)) {
      return invalid(ctx, target, `routing.probes[${index}] must be an object.`);
    }
    const unknownProbe = unsupportedPolicyKey(probe, ["expect", "id", "route"]);
    if (unknownProbe !== undefined) {
      return invalid(
        ctx,
        `${target}/${ocPathSegment(unknownProbe)}`,
        `routing.probes[${index}].${unknownProbe} is not supported.`,
      );
    }
    if (!nonEmptyString(probe.id)) {
      return invalid(
        ctx,
        `${target}/id`,
        `routing.probes[${index}].id must be a non-empty string.`,
      );
    }
    if (ids.has(probe.id.trim())) {
      return invalid(ctx, `${target}/id`, `routing probe id ${probe.id.trim()} must be unique.`);
    }
    ids.add(probe.id.trim());
    const routeFinding = routeShapeFinding(probe.route, index, target, ctx);
    if (routeFinding !== undefined) {
      return routeFinding;
    }
    const expectFinding = expectShapeFinding(probe.expect, index, target, ctx);
    if (expectFinding !== undefined) {
      return expectFinding;
    }
  }
  return undefined;
}

function routeShapeFinding(
  value: unknown,
  index: number,
  target: string,
  ctx: ShapeContext,
): HealthFinding | undefined {
  if (!isRecord(value)) {
    return invalid(ctx, `${target}/route`, `routing.probes[${index}].route must be an object.`);
  }
  const unknown = unsupportedPolicyKey(value, [
    "accountId",
    "channel",
    "guildId",
    "memberRoleIds",
    "parentPeer",
    "peer",
    "teamId",
  ]);
  if (unknown !== undefined) {
    return invalid(
      ctx,
      `${target}/route/${ocPathSegment(unknown)}`,
      `routing.probes[${index}].route.${unknown} is not supported.`,
    );
  }
  if (!nonEmptyString(value.channel)) {
    return invalid(
      ctx,
      `${target}/route/channel`,
      `routing.probes[${index}].route.channel must be a non-empty string.`,
    );
  }
  for (const key of ["accountId", "guildId", "teamId"] as const) {
    if (value[key] !== undefined && !nonEmptyString(value[key])) {
      return invalid(
        ctx,
        `${target}/route/${key}`,
        `routing.probes[${index}].route.${key} must be a non-empty string.`,
      );
    }
  }
  for (const key of ["peer", "parentPeer"] as const) {
    const finding = peerShapeFinding(value[key], index, key, `${target}/route/${key}`, ctx);
    if (finding !== undefined) {
      return finding;
    }
  }
  if (value.memberRoleIds !== undefined) {
    if (
      !Array.isArray(value.memberRoleIds) ||
      value.memberRoleIds.length === 0 ||
      value.memberRoleIds.some((entry) => !nonEmptyString(entry)) ||
      new Set(value.memberRoleIds.map((entry) => String(entry).trim())).size !==
        value.memberRoleIds.length
    ) {
      return invalid(
        ctx,
        `${target}/route/memberRoleIds`,
        `routing.probes[${index}].route.memberRoleIds must contain unique non-empty strings.`,
      );
    }
  }
  return undefined;
}

function peerShapeFinding(
  value: unknown,
  index: number,
  key: "peer" | "parentPeer",
  target: string,
  ctx: ShapeContext,
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return invalid(ctx, target, `routing.probes[${index}].route.${key} must be an object.`);
  }
  const unknown = unsupportedPolicyKey(value, ["id", "kind"]);
  if (unknown !== undefined) {
    return invalid(
      ctx,
      `${target}/${ocPathSegment(unknown)}`,
      `routing.probes[${index}].route.${key}.${unknown} is not supported.`,
    );
  }
  if (!(["channel", "direct", "group"] as const).includes(value.kind as never)) {
    return invalid(
      ctx,
      `${target}/kind`,
      `routing.probes[${index}].route.${key}.kind must be direct, group, or channel.`,
    );
  }
  if (!nonEmptyString(value.id)) {
    return invalid(
      ctx,
      `${target}/id`,
      `routing.probes[${index}].route.${key}.id must be a non-empty string.`,
    );
  }
  return undefined;
}

function expectShapeFinding(
  value: unknown,
  index: number,
  target: string,
  ctx: ShapeContext,
): HealthFinding | undefined {
  if (!isRecord(value)) {
    return invalid(ctx, `${target}/expect`, `routing.probes[${index}].expect must be an object.`);
  }
  const unknown = unsupportedPolicyKey(value, ["agentId", "matchedBy"]);
  if (unknown !== undefined) {
    return invalid(
      ctx,
      `${target}/expect/${ocPathSegment(unknown)}`,
      `routing.probes[${index}].expect.${unknown} is not supported.`,
    );
  }
  if (!nonEmptyString(value.agentId)) {
    return invalid(
      ctx,
      `${target}/expect/agentId`,
      `routing.probes[${index}].expect.agentId must be a non-empty string.`,
    );
  }
  if (value.matchedBy !== undefined) {
    if (
      !Array.isArray(value.matchedBy) ||
      value.matchedBy.length === 0 ||
      value.matchedBy.some(
        (entry) => typeof entry !== "string" || !ROUTING_MATCH_KINDS.includes(entry as never),
      ) ||
      new Set(value.matchedBy).size !== value.matchedBy.length
    ) {
      return invalid(
        ctx,
        `${target}/expect/matchedBy`,
        `routing.probes[${index}].expect.matchedBy must contain unique supported match kinds.`,
      );
    }
  }
  return undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function invalid(ctx: ShapeContext, target: string, message: string): HealthFinding {
  return policyShapeFinding(
    ctx.policyPath,
    `oc://${ctx.policyDocName}/${target}`,
    `${ctx.policyPath} ${message}`,
    `Fix ${ctx.policyPath} so routing uses the documented policy syntax.`,
  );
}
