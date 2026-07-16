import type { ResolvedIMessageAccount } from "./accounts.js";
import type { IMessageProbe } from "./probe.js";

type ProbeIMessageAccount = (params?: {
  timeoutMs?: number;
  cliPath?: string;
  dbPath?: string;
}) => Promise<IMessageProbe>;

export async function probeIMessageStatusAccount(params: {
  account: ResolvedIMessageAccount;
  timeoutMs?: number;
  probeIMessageAccount: ProbeIMessageAccount;
}): Promise<IMessageProbe> {
  return await params.probeIMessageAccount({
    timeoutMs: params.timeoutMs,
    cliPath: params.account.config.cliPath,
    dbPath: params.account.config.dbPath,
  });
}
