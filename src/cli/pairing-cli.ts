import type { Command } from "commander";

import { loadConfig } from "../config/config.js";
import { resolvePairingIdLabel } from "../pairing/pairing-labels.js";
import {
  approveProviderPairingCode,
  listProviderPairingRequests,
  type PairingProvider,
} from "../pairing/pairing-store.js";
import {
  listPairingProviders,
  notifyPairingApproved,
  resolvePairingProvider,
} from "../providers/plugins/pairing.js";

const PROVIDERS: PairingProvider[] = listPairingProviders();

function parseProvider(raw: unknown): PairingProvider {
  return resolvePairingProvider(raw);
}

async function notifyApproved(provider: PairingProvider, id: string) {
  const cfg = loadConfig();
  await notifyPairingApproved({ providerId: provider, id, cfg });
}

export function registerPairingCli(program: Command) {
  const pairing = program
    .command("pairing")
    .description("Secure DM pairing (approve inbound requests)");

  pairing
    .command("list")
    .description("List pending pairing requests")
    .option("--provider <provider>", `Provider (${PROVIDERS.join(", ")})`)
    .argument("[provider]", `Provider (${PROVIDERS.join(", ")})`)
    .option("--json", "Print JSON", false)
    .action(async (providerArg, opts) => {
      const providerRaw = opts.provider ?? providerArg;
      if (!providerRaw) {
        throw new Error(
          `Provider required. Use --provider <provider> or pass it as the first argument (expected one of: ${PROVIDERS.join(", ")})`,
        );
      }
      const provider = parseProvider(providerRaw);
      const requests = await listProviderPairingRequests(provider);
      if (opts.json) {
        console.log(JSON.stringify({ provider, requests }, null, 2));
        return;
      }
      if (requests.length === 0) {
        console.log(`No pending ${provider} pairing requests.`);
        return;
      }
      for (const r of requests) {
        const meta = r.meta ? JSON.stringify(r.meta) : "";
        const idLabel = resolvePairingIdLabel(provider);
        console.log(
          `${r.code}  ${idLabel}=${r.id}${meta ? `  meta=${meta}` : ""}  ${r.createdAt}`,
        );
      }
    });

  pairing
    .command("approve")
    .description("Approve a pairing code and allow that sender")
    .option("--provider <provider>", `Provider (${PROVIDERS.join(", ")})`)
    .argument(
      "<codeOrProvider>",
      "Pairing code (or provider when using 2 args)",
    )
    .argument("[code]", "Pairing code (when provider is passed as the 1st arg)")
    .option("--notify", "Notify the requester on the same provider", false)
    .action(async (codeOrProvider, code, opts) => {
      const providerRaw = opts.provider ?? codeOrProvider;
      const resolvedCode = opts.provider ? codeOrProvider : code;
      if (!opts.provider && !code) {
        throw new Error(
          `Usage: clawdbot pairing approve <provider> <code> (or: clawdbot pairing approve --provider <provider> <code>)`,
        );
      }
      if (opts.provider && code != null) {
        throw new Error(
          `Too many arguments. Use: clawdbot pairing approve --provider <provider> <code>`,
        );
      }
      const provider = parseProvider(providerRaw);
      const approved = await approveProviderPairingCode({
        provider,
        code: String(resolvedCode),
      });
      if (!approved) {
        throw new Error(
          `No pending pairing request found for code: ${String(resolvedCode)}`,
        );
      }

      console.log(`Approved ${provider} sender ${approved.id}.`);

      if (!opts.notify) return;
      await notifyApproved(provider, approved.id).catch((err) => {
        console.log(`Failed to notify requester: ${String(err)}`);
      });
    });
}
