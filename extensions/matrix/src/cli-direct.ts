import type { Command } from "commander";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import * as cli from "./cli-shared.js";
import { resolveMatrixAccount } from "./matrix/accounts.js";
import type { MatrixDirectRoomCandidate } from "./matrix/direct-management.js";
import { getMatrixRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

const loadMatrixActionClientModule = createLazyRuntimeModule(
  () => import("./matrix/actions/client.js"),
);

const loadMatrixDirectManagementModule = createLazyRuntimeModule(
  () => import("./matrix/direct-management.js"),
);

type MatrixCliDirectRoomCandidate = {
  roomId: string;
  source: "account-data" | "joined";
  strict: boolean;
  joinedMembers: string[] | null;
};

type MatrixCliDirectRoomInspection = {
  accountId: string;
  remoteUserId: string;
  selfUserId: string | null;
  mappedRoomIds: string[];
  mappedRooms: MatrixCliDirectRoomCandidate[];
  discoveredStrictRoomIds: string[];
  activeRoomId: string | null;
};

type MatrixCliDirectRoomRepair = MatrixCliDirectRoomInspection & {
  encrypted: boolean;
  createdRoomId: string | null;
  changed: boolean;
  directContentBefore: Record<string, string[]>;
  directContentAfter: Record<string, string[]>;
};

function printDirectRoomCandidate(room: MatrixCliDirectRoomCandidate): void {
  const members =
    room.joinedMembers === null
      ? "unavailable"
      : room.joinedMembers.map((member) => cli.formatMatrixCliText(member)).join(", ") || "none";
  console.log(
    `- ${cli.formatMatrixCliText(room.roomId)} [${room.source}] strict=${
      room.strict ? "yes" : "no"
    } joined=${members}`,
  );
}

function printDirectRoomInspection(result: MatrixCliDirectRoomInspection): void {
  cli.printAccountLabel(result.accountId);
  console.log(`Peer: ${cli.formatMatrixCliText(result.remoteUserId)}`);
  console.log(`Self: ${cli.formatMatrixCliText(result.selfUserId)}`);
  console.log(`Active direct room: ${cli.formatMatrixCliText(result.activeRoomId, "none")}`);
  console.log(
    `Mapped rooms: ${
      result.mappedRoomIds.length
        ? result.mappedRoomIds.map((roomId) => cli.formatMatrixCliText(roomId)).join(", ")
        : "none"
    }`,
  );
  console.log(
    `Discovered strict rooms: ${
      result.discoveredStrictRoomIds.length
        ? result.discoveredStrictRoomIds.map((roomId) => cli.formatMatrixCliText(roomId)).join(", ")
        : "none"
    }`,
  );
  if (result.mappedRooms.length > 0) {
    console.log("Mapped room details:");
    for (const room of result.mappedRooms) {
      printDirectRoomCandidate(room);
    }
  }
}

async function inspectMatrixDirectRoom(params: {
  accountId: string;
  userId: string;
}): Promise<MatrixCliDirectRoomInspection> {
  const cfg = getMatrixRuntime().config.current() as CoreConfig;
  const [{ withResolvedActionClient }, { inspectMatrixDirectRooms }] = await Promise.all([
    loadMatrixActionClientModule(),
    loadMatrixDirectManagementModule(),
  ]);
  return await withResolvedActionClient(
    { accountId: params.accountId, cfg },
    async (client) => {
      const inspection = await inspectMatrixDirectRooms({
        client,
        remoteUserId: params.userId,
      });
      return {
        accountId: params.accountId,
        remoteUserId: inspection.remoteUserId,
        selfUserId: inspection.selfUserId,
        mappedRoomIds: inspection.mappedRoomIds,
        mappedRooms: inspection.mappedRooms.map(toCliDirectRoomCandidate),
        discoveredStrictRoomIds: inspection.discoveredStrictRoomIds,
        activeRoomId: inspection.activeRoomId,
      };
    },
    "persist",
  );
}

async function repairMatrixDirectRoom(params: {
  accountId: string;
  userId: string;
}): Promise<MatrixCliDirectRoomRepair> {
  const cfg = getMatrixRuntime().config.current() as CoreConfig;
  const account = resolveMatrixAccount({ cfg, accountId: params.accountId });
  const [{ withStartedActionClient }, { repairMatrixDirectRooms }] = await Promise.all([
    loadMatrixActionClientModule(),
    loadMatrixDirectManagementModule(),
  ]);
  return await withStartedActionClient({ accountId: params.accountId, cfg }, async (client) => {
    const repaired = await repairMatrixDirectRooms({
      client,
      remoteUserId: params.userId,
      encrypted: account.config.encryption === true,
    });
    return {
      accountId: params.accountId,
      remoteUserId: repaired.remoteUserId,
      selfUserId: repaired.selfUserId,
      mappedRoomIds: repaired.mappedRoomIds,
      mappedRooms: repaired.mappedRooms.map(toCliDirectRoomCandidate),
      discoveredStrictRoomIds: repaired.discoveredStrictRoomIds,
      activeRoomId: repaired.activeRoomId,
      encrypted: account.config.encryption === true,
      createdRoomId: repaired.createdRoomId,
      changed: repaired.changed,
      directContentBefore: repaired.directContentBefore,
      directContentAfter: repaired.directContentAfter,
    };
  });
}

function toCliDirectRoomCandidate(room: MatrixDirectRoomCandidate): MatrixCliDirectRoomCandidate {
  return {
    roomId: room.roomId,
    source: room.source,
    strict: room.strict,
    joinedMembers: room.joinedMembers,
  };
}

export function registerMatrixDirectCommands(root: Command): void {
  const direct = root.command("direct").description("Inspect and repair Matrix direct-room state");

  direct
    .command("inspect")
    .description("Inspect direct-room mappings for a Matrix user")
    .requiredOption("--user-id <id>", "Peer Matrix user ID")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (options: { userId: string; account?: string; verbose?: boolean; json?: boolean }) => {
        const accountId = cli.resolveMatrixCliAccountContext(options.account).accountId;
        await cli.runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () =>
            await inspectMatrixDirectRoom({
              accountId,
              userId: options.userId,
            }),
          onText: (result) => {
            printDirectRoomInspection(result);
          },
          errorPrefix: "Direct room inspection failed",
        });
      },
    );

  direct
    .command("repair")
    .description("Repair Matrix direct-room mappings for a Matrix user")
    .requiredOption("--user-id <id>", "Peer Matrix user ID")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (options: { userId: string; account?: string; verbose?: boolean; json?: boolean }) => {
        const accountId = cli.resolveMatrixCliAccountContext(options.account).accountId;
        await cli.runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () =>
            await repairMatrixDirectRoom({
              accountId,
              userId: options.userId,
            }),
          onText: (result, verbose) => {
            printDirectRoomInspection(result);
            console.log(`Encrypted room creation: ${result.encrypted ? "enabled" : "disabled"}`);
            console.log(`Created room: ${cli.formatMatrixCliText(result.createdRoomId, "none")}`);
            console.log(`m.direct updated: ${result.changed ? "yes" : "no"}`);
            if (verbose) {
              console.log(
                `m.direct before: ${cli.formatMatrixCliText(JSON.stringify(result.directContentBefore[result.remoteUserId] ?? []))}`,
              );
              console.log(
                `m.direct after: ${cli.formatMatrixCliText(JSON.stringify(result.directContentAfter[result.remoteUserId] ?? []))}`,
              );
            }
          },
          errorPrefix: "Direct room repair failed",
        });
      },
    );
}
