import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { IrcChannelConfig } from "./types.js";

export type IrcGroupMatch = {
  allowed: boolean;
  groupConfig?: IrcChannelConfig;
  wildcardConfig?: IrcChannelConfig;
  hasConfiguredGroups: boolean;
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
      // Explicit disables are represented later as ingress route facts.
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
        // Explicit disables are represented later as ingress route facts.
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
      // Explicit disables are represented later as ingress route facts.
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
