import type { Command } from "commander";
import * as cli from "./cli-shared.js";
import { registerMatrixVerificationBackupCommands } from "./cli-verification-backup.js";
import * as verification from "./matrix/actions/verification.js";
import type { CoreConfig } from "./types.js";

function matrixCliVerificationDmLookupOptions(options: cli.MatrixCliVerificationCommandOptions): {
  verificationDmRoomId?: string;
  verificationDmUserId?: string;
} {
  const lookup: {
    verificationDmRoomId?: string;
    verificationDmUserId?: string;
  } = {};
  if (options.roomId !== undefined) {
    lookup.verificationDmRoomId = options.roomId;
  }
  if (options.userId !== undefined) {
    lookup.verificationDmUserId = options.userId;
  }
  return lookup;
}

function formatMatrixVerificationDmFollowupParts(params: {
  roomId?: string;
  userId?: string;
}): string[] {
  if (!params.roomId || !params.userId) {
    return [];
  }
  return [
    "--user-id",
    cli.sanitizeMatrixCliText(params.userId),
    "--room-id",
    cli.sanitizeMatrixCliText(params.roomId),
  ];
}

function formatMatrixVerificationSummaryDmFollowupParts(
  summary: cli.MatrixCliVerificationSummary,
): string[] {
  return formatMatrixVerificationDmFollowupParts({
    roomId: summary.roomId,
    userId: summary.otherUserId,
  });
}

function formatMatrixVerificationOptionsDmFollowupParts(
  options: cli.MatrixCliVerificationCommandOptions,
): string[] {
  return formatMatrixVerificationDmFollowupParts({
    roomId: options.roomId,
    userId: options.userId,
  });
}

function formatMatrixVerificationPreferredDmFollowupParts(
  summary: cli.MatrixCliVerificationSummary,
  options: cli.MatrixCliVerificationCommandOptions,
): string[] {
  const summaryParts = formatMatrixVerificationSummaryDmFollowupParts(summary);
  return summaryParts.length
    ? summaryParts
    : formatMatrixVerificationOptionsDmFollowupParts(options);
}

function formatMatrixVerificationFollowupCommand(params: {
  action: string;
  requestId: string;
  accountId?: string;
  dmParts?: string[];
}): string {
  return cli.formatMatrixCliCommandParts(
    ["verify", params.action, ...(params.dmParts ?? []), "--", params.requestId],
    params.accountId,
  );
}

function printMatrixVerificationSasGuidance(
  requestId: string,
  accountId?: string,
  dmParts: string[] = [],
): void {
  cli.printGuidance([
    `Compare the emoji or decimals with the other Matrix client.`,
    `If they match, run ${formatMatrixVerificationFollowupCommand({ action: "confirm-sas", requestId, accountId, dmParts })}.`,
    `If they do not match, run ${formatMatrixVerificationFollowupCommand({ action: "mismatch-sas", requestId, accountId, dmParts })}.`,
  ]);
}

function formatMatrixVerificationCommandId(summary: cli.MatrixCliVerificationSummary): string {
  return cli.sanitizeMatrixCliText(summary.transactionId ?? summary.id);
}

async function promptMatrixVerificationSasMatch(): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question("Do the emoji or decimals match? Type yes to confirm: ");
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function printMatrixVerificationRequestGuidance(
  summary: cli.MatrixCliVerificationSummary,
  accountId?: string,
): void {
  const requestId = formatMatrixVerificationCommandId(summary);
  const dmParts = formatMatrixVerificationSummaryDmFollowupParts(summary);
  cli.printGuidance([
    `Accept the verification request in another Matrix client for this account.`,
    `Then run ${formatMatrixVerificationFollowupCommand({ action: "start", requestId, accountId, dmParts })} to start SAS verification.`,
    `Run ${formatMatrixVerificationFollowupCommand({ action: "sas", requestId, accountId, dmParts })} to display the SAS emoji or decimals.`,
    `When the SAS matches, run ${formatMatrixVerificationFollowupCommand({ action: "confirm-sas", requestId, accountId, dmParts })}.`,
  ]);
}

async function runMatrixCliVerificationSummaryCommand(params: {
  options: cli.MatrixCliVerificationCommandOptions;
  run: (accountId: string, cfg: CoreConfig) => Promise<cli.MatrixCliVerificationSummary>;
  afterText?: (summary: cli.MatrixCliVerificationSummary, accountId: string) => void;
  errorPrefix: string;
}): Promise<void> {
  const { accountId, cfg } = cli.resolveMatrixCliAccountContext(params.options.account);
  await cli.runMatrixCliCommand({
    verbose: params.options.verbose === true,
    json: params.options.json === true,
    run: async () => await params.run(accountId, cfg),
    onText: (summary) => {
      cli.printAccountLabel(accountId);
      cli.printMatrixVerificationSummary(summary);
      params.afterText?.(summary, accountId);
    },
    errorPrefix: params.errorPrefix,
  });
}

async function runMatrixCliSelfVerificationCommand(
  options: cli.MatrixCliSelfVerificationCommandOptions,
): Promise<void> {
  let resolvedAccountId: string | undefined;
  await cli.runMatrixCliCommand({
    verbose: options.verbose === true,
    json: false,
    run: async () => {
      const timeoutMs = cli.parseOptionalInt(options.timeoutMs, "--timeout-ms", { min: 1 });
      const { accountId, cfg } = cli.resolveMatrixCliAccountContext(options.account);
      resolvedAccountId = accountId;
      return await verification.runMatrixSelfVerification({
        accountId,
        cfg,
        timeoutMs,
        onRequested: (summary) => {
          cli.printAccountLabel(accountId);
          cli.printMatrixVerificationSummary(summary);
          console.log("Accept this verification request in another Matrix client.");
        },
        onReady: (summary) => {
          console.log("Verification request accepted.");
          if (!summary.hasSas) {
            console.log("Starting SAS verification...");
          }
        },
        onSas: (summary) => {
          cli.printMatrixVerificationSas(summary.sas ?? {});
          console.log("Compare this SAS with the other Matrix client.");
        },
        confirmSas: async () => await promptMatrixVerificationSasMatch(),
      });
    },
    onText: (summary, verbose) => {
      cli.printMatrixVerificationSummary(summary);
      console.log(`Device verified by owner: ${summary.deviceOwnerVerified ? "yes" : "no"}`);
      cli.printVerificationTrustDiagnostics(summary.ownerVerification);
      cli.printVerificationBackupSummary(summary.ownerVerification);
      if (verbose) {
        cli.printVerificationBackupStatus(summary.ownerVerification);
      }
      console.log("Self-verification complete.");
    },
    onTextError: () => {
      const accountId = resolvedAccountId ?? options.account;
      cli.printGuidance([
        `Run ${cli.formatMatrixCliCommand("verify self", accountId)} again and accept the request in another verified Matrix client for this account.`,
        `Then run ${cli.formatMatrixCliCommand("verify status --verbose", accountId)} to confirm Cross-signing verified: yes and Signed by owner: yes.`,
      ]);
    },
    errorPrefix: "Self-verification failed",
  });
}

export function registerMatrixVerificationCommands(root: Command): void {
  const verify = root.command("verify").description("Device verification for Matrix E2EE");
  verify
    .command("list")
    .description("List pending Matrix verification requests")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (options: { account?: string; verbose?: boolean; json?: boolean }) => {
      const { accountId, cfg } = cli.resolveMatrixCliAccountContext(options.account);
      await cli.runMatrixCliCommand({
        verbose: options.verbose === true,
        json: options.json === true,
        run: async () => await verification.listMatrixVerifications({ accountId, cfg }),
        onText: (summaries) => {
          cli.printAccountLabel(accountId);
          cli.printMatrixVerificationSummaries(summaries);
        },
        errorPrefix: "Verification listing failed",
      });
    });

  verify
    .command("self")
    .description("Interactively self-verify this Matrix device")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--timeout-ms <ms>", "How long to wait for the other Matrix client")
    .option("--verbose", "Show detailed diagnostics")
    .action(async (options: cli.MatrixCliSelfVerificationCommandOptions) => {
      await runMatrixCliSelfVerificationCommand(options);
    });

  verify
    .command("request")
    .description("Request Matrix device verification from another Matrix client")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--own-user", "Request self-verification for this Matrix account")
    .option("--user-id <id>", "Matrix user ID to verify")
    .option("--device-id <id>", "Matrix device ID to verify")
    .option("--room-id <id>", "Matrix direct-message room ID for verification")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        account?: string;
        ownUser?: boolean;
        userId?: string;
        deviceId?: string;
        roomId?: string;
        verbose?: boolean;
        json?: boolean;
      }) => {
        const { accountId, cfg } = cli.resolveMatrixCliAccountContext(options.account);
        await cli.runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () => {
            if (
              options.ownUser === true &&
              (options.userId || options.deviceId || options.roomId)
            ) {
              throw new Error(
                "--own-user cannot be combined with --user-id, --device-id, or --room-id",
              );
            }
            return await verification.requestMatrixVerification({
              accountId,
              cfg,
              ownUser: options.ownUser === true ? true : undefined,
              userId: options.userId,
              deviceId: options.deviceId,
              roomId: options.roomId,
            });
          },
          onText: (summary) => {
            cli.printAccountLabel(accountId);
            cli.printMatrixVerificationSummary(summary);
            printMatrixVerificationRequestGuidance(summary, accountId);
          },
          errorPrefix: "Verification request failed",
        });
      },
    );

  verify
    .command("accept <id>")
    .description("Accept an inbound Matrix verification request")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--user-id <id>", "Matrix user ID for DM verification follow-up")
    .option("--room-id <id>", "Matrix direct-message room ID for verification follow-up")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (id: string, options: cli.MatrixCliVerificationCommandOptions) => {
      await runMatrixCliVerificationSummaryCommand({
        options,
        run: async (accountId, cfg) =>
          await verification.acceptMatrixVerification(id, {
            accountId,
            cfg,
            ...matrixCliVerificationDmLookupOptions(options),
          }),
        afterText: (summary, accountId) => {
          const requestId = formatMatrixVerificationCommandId(summary);
          const dmParts = formatMatrixVerificationPreferredDmFollowupParts(summary, options);
          cli.printGuidance([
            `Run ${formatMatrixVerificationFollowupCommand({ action: "start", requestId, accountId, dmParts })} to start SAS verification.`,
          ]);
        },
        errorPrefix: "Verification accept failed",
      });
    });

  verify
    .command("start <id>")
    .description("Start SAS verification for a Matrix verification request")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--user-id <id>", "Matrix user ID for DM verification follow-up")
    .option("--room-id <id>", "Matrix direct-message room ID for verification follow-up")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (id: string, options: cli.MatrixCliVerificationCommandOptions) => {
      await runMatrixCliVerificationSummaryCommand({
        options,
        run: async (accountId, cfg) =>
          await verification.startMatrixVerification(id, {
            accountId,
            cfg,
            method: "sas",
            ...matrixCliVerificationDmLookupOptions(options),
          }),
        afterText: (summary, accountId) =>
          printMatrixVerificationSasGuidance(
            formatMatrixVerificationCommandId(summary),
            accountId,
            formatMatrixVerificationPreferredDmFollowupParts(summary, options),
          ),
        errorPrefix: "Verification start failed",
      });
    });

  verify
    .command("sas <id>")
    .description("Show SAS emoji or decimals for a Matrix verification request")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--user-id <id>", "Matrix user ID for DM verification follow-up")
    .option("--room-id <id>", "Matrix direct-message room ID for verification follow-up")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (id: string, options: cli.MatrixCliVerificationCommandOptions) => {
      const { accountId, cfg } = cli.resolveMatrixCliAccountContext(options.account);
      await cli.runMatrixCliCommand({
        verbose: options.verbose === true,
        json: options.json === true,
        run: async () =>
          await verification.getMatrixVerificationSas(id, {
            accountId,
            cfg,
            ...matrixCliVerificationDmLookupOptions(options),
          }),
        onText: (sas) => {
          const requestId = cli.formatMatrixCliText(id);
          cli.printAccountLabel(accountId);
          console.log(`Verification id: ${requestId}`);
          cli.printMatrixVerificationSas(sas);
          printMatrixVerificationSasGuidance(
            requestId,
            accountId,
            formatMatrixVerificationOptionsDmFollowupParts(options),
          );
        },
        errorPrefix: "Verification SAS lookup failed",
      });
    });

  verify
    .command("confirm-sas <id>")
    .description("Confirm matching SAS emoji or decimals for a Matrix verification request")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--user-id <id>", "Matrix user ID for DM verification follow-up")
    .option("--room-id <id>", "Matrix direct-message room ID for verification follow-up")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (id: string, options: cli.MatrixCliVerificationCommandOptions) => {
      await runMatrixCliVerificationSummaryCommand({
        options,
        run: async (accountId, cfg) =>
          await verification.confirmMatrixVerificationSas(id, {
            accountId,
            cfg,
            ...matrixCliVerificationDmLookupOptions(options),
          }),
        errorPrefix: "Verification SAS confirm failed",
      });
    });

  verify
    .command("mismatch-sas <id>")
    .description("Reject a Matrix SAS verification when the emoji or decimals do not match")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--user-id <id>", "Matrix user ID for DM verification follow-up")
    .option("--room-id <id>", "Matrix direct-message room ID for verification follow-up")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (id: string, options: cli.MatrixCliVerificationCommandOptions) => {
      await runMatrixCliVerificationSummaryCommand({
        options,
        run: async (accountId, cfg) =>
          await verification.mismatchMatrixVerificationSas(id, {
            accountId,
            cfg,
            ...matrixCliVerificationDmLookupOptions(options),
          }),
        errorPrefix: "Verification SAS mismatch failed",
      });
    });

  verify
    .command("cancel <id>")
    .description("Cancel a Matrix verification request")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--user-id <id>", "Matrix user ID for DM verification follow-up")
    .option("--room-id <id>", "Matrix direct-message room ID for verification follow-up")
    .option("--reason <text>", "Cancellation reason")
    .option("--code <code>", "Matrix cancellation code")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (
        id: string,
        options: cli.MatrixCliVerificationCommandOptions & {
          reason?: string;
          code?: string;
        },
      ) => {
        await runMatrixCliVerificationSummaryCommand({
          options,
          run: async (accountId, cfg) =>
            await verification.cancelMatrixVerification(id, {
              accountId,
              cfg,
              reason: options.reason,
              code: options.code,
              ...matrixCliVerificationDmLookupOptions(options),
            }),
          errorPrefix: "Verification cancel failed",
        });
      },
    );

  verify
    .command("status")
    .description("Check Matrix device verification status")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--include-recovery-key", "Include stored recovery key in output")
    .option(
      "--allow-degraded-local-state",
      "Return best-effort diagnostics without preparing the Matrix account",
    )
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        allowDegradedLocalState?: boolean;
        account?: string;
        verbose?: boolean;
        includeRecoveryKey?: boolean;
        json?: boolean;
      }) => {
        const { accountId, cfg } = cli.resolveMatrixCliAccountContext(options.account);
        await cli.runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () =>
            await verification.getMatrixVerificationStatus({
              accountId,
              cfg,
              includeRecoveryKey: options.includeRecoveryKey === true,
              ...(options.allowDegradedLocalState === true ? { readiness: "none" as const } : {}),
            }),
          onText: (status, verbose) => {
            cli.printAccountLabel(accountId);
            cli.printVerificationStatus(status, verbose, accountId);
          },
          shouldFail: (status) => status.serverDeviceKnown === false,
          errorPrefix: "Error",
        });
      },
    );

  registerMatrixVerificationBackupCommands(verify);
}
