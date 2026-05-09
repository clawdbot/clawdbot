import {
  type TimeFormatPreference,
  formatUserTime,
  resolveUserTimeFormat,
  resolveUserTimezone,
} from "./date-time.js";

export type CronStyleNow = {
  userTimezone: string;
  formattedTime: string;
  timeLine: string;
};

type TimeConfigLike = {
  agents?: {
    defaults?: {
      userTimezone?: string;
      timeFormat?: TimeFormatPreference;
    };
  };
};

export function resolveCronStyleNow(cfg: TimeConfigLike, nowMs: number): CronStyleNow {
  const userTimezone = resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
  const userTimeFormat = resolveUserTimeFormat(cfg.agents?.defaults?.timeFormat);
  const formattedTime =
    formatUserTime(new Date(nowMs), userTimezone, userTimeFormat) ?? new Date(nowMs).toISOString();
  const utcTime = new Date(nowMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const timeLine = `Current time: ${formattedTime} (${userTimezone})\nReference UTC: ${utcTime}`;
  return { userTimezone, formattedTime, timeLine };
}

export function appendCronStyleCurrentTimeLine(text: string, cfg: TimeConfigLike, nowMs: number) {
  const base = text.trimEnd();
  if (!base || base.includes("Current time:")) {
    return base;
  }
  const { timeLine } = resolveCronStyleNow(cfg, nowMs);
  return `${base}\n${timeLine}`;
}
