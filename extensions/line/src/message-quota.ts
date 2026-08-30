// Line plugin module implements monthly message quota reads.
import { messagingApi } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveLineAccount } from "./accounts.js";
import { resolveLineChannelAccessToken } from "./channel-access-token.js";
import type { LineMessageQuota } from "./types.js";

/**
 * Whether LINE will refuse further pushes until the allowance resets next month.
 * Derived on read so no caller has to keep a duplicate flag in sync, and narrowed
 * so a caller that reports the numbers does not have to re-check the plan.
 */
export function isLineMessageQuotaExhausted(
  quota: LineMessageQuota,
): quota is Extract<LineMessageQuota, { kind: "limited" }> {
  return quota.kind === "limited" && quota.used >= quota.limit;
}

/** The two quota reads this module needs, so tests can supply them without a network client. */
export type LineMessageQuotaReader = Pick<
  messagingApi.MessagingApiClient,
  "getMessageQuota" | "getMessageQuotaConsumption"
>;

/**
 * Reads the account's monthly allowance from LINE, which owns it.
 *
 * Returns undefined when LINE cannot answer: callers must treat an unreadable
 * quota as "unknown" rather than as proof that room remains, because the reads
 * run on already-degraded paths where a second failure is expected.
 */
export async function readLineMessageQuota(
  reader: LineMessageQuotaReader,
): Promise<LineMessageQuota | undefined> {
  try {
    const quota = await reader.getMessageQuota();
    if (quota.type !== "limited" || typeof quota.value !== "number") {
      return { kind: "unlimited" };
    }
    const consumption = await reader.getMessageQuotaConsumption();
    if (typeof consumption.totalUsage !== "number") {
      return undefined;
    }
    return { kind: "limited", limit: quota.value, used: consumption.totalUsage };
  } catch {
    return undefined;
  }
}

/** Builds a quota reader for one channel access token. */
export function createLineMessageQuotaReader(channelAccessToken: string): LineMessageQuotaReader {
  return new messagingApi.MessagingApiClient({ channelAccessToken });
}

/**
 * Reads the allowance for a configured account.
 *
 * Callers on failure paths cannot assume credentials still resolve, so an
 * unresolvable account reads as unknown rather than throwing a second error on
 * top of the one being reported.
 */
export async function readLineAccountMessageQuota(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<LineMessageQuota | undefined> {
  let token: string;
  try {
    const account = resolveLineAccount({
      cfg: params.cfg,
      accountId: params.accountId ?? undefined,
    });
    token = resolveLineChannelAccessToken(undefined, account);
  } catch {
    return undefined;
  }
  return await readLineMessageQuota(createLineMessageQuotaReader(token));
}

/**
 * Names the allowance as the reason a send was refused, or undefined when it was
 * not. Reported instead of LINE's bare "429 - Too Many Requests", which cannot
 * tell an operator that the account is out of messages until next month.
 */
export function describeLineQuotaRefusal(quota: LineMessageQuota | undefined): string | undefined {
  return quota && isLineMessageQuotaExhausted(quota)
    ? `LINE refused the message: ${quota.used}/${quota.limit} monthly messages used. Sending resumes when the allowance resets next month.`
    : undefined;
}
