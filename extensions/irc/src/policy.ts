import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { normalizeIrcAllowlist, resolveIrcAllowlistMatch } from "./normalize.js";
import type { IrcAccountConfig, IrcChannelConfig } from "./types.js";
import type { IrcInboundMessage } from "./types.js";

type IrcGroupMatch = {
  allowed: boolean;
  groupConfig?: IrcChannelConfig;
  wildcardConfig?: IrcChannelConfig;
  hasConfiguredGroups: boolean;
};

type IrcGroupAccessGate = {
  allowed: boolean;
  reason: string;
};

export function resolveIrcGroupMatch(params: {
  groups?: Record<string, IrcChannelConfig>;
  target: string;
}): IrcGroupMatch {
  const groups = params.groups ?? {};
  const hasConfiguredGroups = Object.keys(groups).length > 0;

  // IRC channel targets are case-insensitive, but config keys are plain strings.
  // To avoid surprising drops (e.g. "#TUIRC-DEV" vs "#tuirc-dev"), match
  // group config keys case-insensitively.
  const direct = groups[params.target];
  if (direct) {
    return {
      // "allowed" means the target matched an allowlisted key.
      // Explicit disables are handled later by resolveIrcGroupAccessGate.
      allowed: true,
      groupConfig: direct,
      wildcardConfig: groups["*"],
      hasConfiguredGroups,
    };
  }

  const targetLower = normalizeLowercaseStringOrEmpty(params.target);
  const directKey = Object.keys(groups).find(
    (key) => normalizeLowercaseStringOrEmpty(key) === targetLower,
  );
  if (directKey) {
    const matched = groups[directKey];
    if (matched) {
      return {
        // "allowed" means the target matched an allowlisted key.
        // Explicit disables are handled later by resolveIrcGroupAccessGate.
        allowed: true,
        groupConfig: matched,
        wildcardConfig: groups["*"],
        hasConfiguredGroups,
      };
    }
  }

  const wildcard = groups["*"];
  if (wildcard) {
    return {
      // "allowed" means the target matched an allowlisted key.
      // Explicit disables are handled later by resolveIrcGroupAccessGate.
      allowed: true,
      wildcardConfig: wildcard,
      hasConfiguredGroups,
    };
  }
  return {
    allowed: false,
    hasConfiguredGroups,
  };
}

export function resolveIrcGroupAccessGate(params: {
  groupPolicy: IrcAccountConfig["groupPolicy"];
  groupMatch: IrcGroupMatch;
}): IrcGroupAccessGate {
  const policy = params.groupPolicy ?? "allowlist";
  if (policy === "disabled") {
    return { allowed: false, reason: "groupPolicy=disabled" };
  }

  // In open mode, unconfigured channels are allowed (mention-gated) but explicit
  // per-channel/wildcard disables still apply.
  if (policy === "allowlist") {
    if (!params.groupMatch.hasConfiguredGroups) {
      return {
        allowed: false,
        reason: "groupPolicy=allowlist and no groups configured",
      };
    }
    if (!params.groupMatch.allowed) {
      return { allowed: false, reason: "not allowlisted" };
    }
  }

  if (
    params.groupMatch.groupConfig?.enabled === false ||
    params.groupMatch.wildcardConfig?.enabled === false
  ) {
    return { allowed: false, reason: "disabled" };
  }

  return { allowed: true, reason: policy === "open" ? "open" : "allowlisted" };
}

export function resolveIrcRequireMention(params: {
  groupConfig?: IrcChannelConfig;
  wildcardConfig?: IrcChannelConfig;
}): boolean {
  if (params.groupConfig?.requireMention !== undefined) {
    return params.groupConfig.requireMention;
  }
  if (params.wildcardConfig?.requireMention !== undefined) {
    return params.wildcardConfig.requireMention;
  }
  return true;
}

export function resolveIrcMentionGate(params: {
  isGroup: boolean;
  requireMention: boolean;
  wasMentioned: boolean;
  hasControlCommand: boolean;
  allowTextCommands: boolean;
  commandAuthorized: boolean;
}): { shouldSkip: boolean; reason: string } {
  if (!params.isGroup) {
    return { shouldSkip: false, reason: "direct" };
  }
  if (!params.requireMention) {
    return { shouldSkip: false, reason: "mention-not-required" };
  }
  if (params.wasMentioned) {
    return { shouldSkip: false, reason: "mentioned" };
  }
  if (params.hasControlCommand && params.allowTextCommands && params.commandAuthorized) {
    return { shouldSkip: false, reason: "authorized-command" };
  }
  return { shouldSkip: true, reason: "missing-mention" };
}

export function resolveIrcGroupSenderAllowed(params: {
  groupPolicy: IrcAccountConfig["groupPolicy"];
  message: IrcInboundMessage;
  outerAllowFrom: string[];
  innerAllowFrom: string[];
  allowNameMatching?: boolean;
}): boolean {
  const policy = params.groupPolicy ?? "allowlist";
  const inner = normalizeIrcAllowlist(params.innerAllowFrom);
  const outer = normalizeIrcAllowlist(params.outerAllowFrom);

  if (inner.length > 0) {
    return resolveIrcAllowlistMatch({
      allowFrom: inner,
      message: params.message,
      allowNameMatching: params.allowNameMatching,
    }).allowed;
  }
  if (outer.length > 0) {
    return resolveIrcAllowlistMatch({
      allowFrom: outer,
      message: params.message,
      allowNameMatching: params.allowNameMatching,
    }).allowed;
  }
  return policy === "open";
}
