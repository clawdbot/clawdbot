import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "vitest";
import { MIN_CLIENT_PROTOCOL_VERSION, PROTOCOL_VERSION } from "./version.js";

type ProtocolLevels = {
  min: number;
  max: number;
};

const expectedLevels: ProtocolLevels = {
  min: MIN_CLIENT_PROTOCOL_VERSION,
  max: PROTOCOL_VERSION,
};

async function readRepoFile(relativePath: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), relativePath), "utf8");
}

function extractInteger(
  content: string,
  pattern: RegExp,
  relativePath: string,
  label: string,
): number {
  const match = pattern.exec(content);
  if (!match) {
    throw new Error(
      `${relativePath}: missing ${label}; keep native Gateway protocol levels in sync with src/gateway/protocol/version.ts.`,
    );
  }
  return Number.parseInt(match[1], 10);
}

function assertLevelsMatch(relativePath: string, actual: ProtocolLevels): void {
  if (actual.min === expectedLevels.min && actual.max === expectedLevels.max) {
    return;
  }
  throw new Error(
    `${relativePath}: Gateway protocol level mismatch: expected min=${expectedLevels.min} max=${expectedLevels.max} from src/gateway/protocol/version.ts, got min=${actual.min} max=${actual.max}. Update the native constants/generated artifacts before shipping.`,
  );
}

function assertPattern(
  content: string,
  relativePath: string,
  pattern: RegExp,
  message: string,
): void {
  if (pattern.test(content)) {
    return;
  }
  throw new Error(`${relativePath}: ${message}`);
}

describe("native Gateway protocol levels", () => {
  it("match the TypeScript source of truth", async () => {
    if (MIN_CLIENT_PROTOCOL_VERSION > PROTOCOL_VERSION) {
      throw new Error(
        `src/gateway/protocol/version.ts: MIN_CLIENT_PROTOCOL_VERSION (${MIN_CLIENT_PROTOCOL_VERSION}) must not exceed PROTOCOL_VERSION (${PROTOCOL_VERSION}).`,
      );
    }

    const swiftGeneratedPath =
      "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift";
    const swiftGenerated = await readRepoFile(swiftGeneratedPath);
    assertLevelsMatch(swiftGeneratedPath, {
      min: extractInteger(
        swiftGenerated,
        /public let GATEWAY_MIN_PROTOCOL_VERSION = (\d+)/,
        swiftGeneratedPath,
        "GATEWAY_MIN_PROTOCOL_VERSION",
      ),
      max: extractInteger(
        swiftGenerated,
        /public let GATEWAY_PROTOCOL_VERSION = (\d+)/,
        swiftGeneratedPath,
        "GATEWAY_PROTOCOL_VERSION",
      ),
    });

    const androidPath = "apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewayProtocol.kt";
    const android = await readRepoFile(androidPath);
    assertLevelsMatch(androidPath, {
      min: extractInteger(
        android,
        /const val GATEWAY_MIN_PROTOCOL_VERSION = (\d+)/,
        androidPath,
        "GATEWAY_MIN_PROTOCOL_VERSION",
      ),
      max: extractInteger(
        android,
        /const val GATEWAY_PROTOCOL_VERSION = (\d+)/,
        androidPath,
        "GATEWAY_PROTOCOL_VERSION",
      ),
    });
  });

  it("uses the min constant for native connect compatibility ranges", async () => {
    const swiftConnectFiles = [
      "apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayChannel.swift",
      "apps/macos/Sources/OpenClawMacCLI/WizardCommand.swift",
    ];
    for (const relativePath of swiftConnectFiles) {
      const content = await readRepoFile(relativePath);
      assertPattern(
        content,
        relativePath,
        /"minProtocol": ProtoAnyCodable\(GATEWAY_MIN_PROTOCOL_VERSION\)/,
        "connect params must advertise GATEWAY_MIN_PROTOCOL_VERSION as minProtocol.",
      );
      assertPattern(
        content,
        relativePath,
        /"maxProtocol": ProtoAnyCodable\(GATEWAY_PROTOCOL_VERSION\)/,
        "connect params must advertise GATEWAY_PROTOCOL_VERSION as maxProtocol.",
      );
    }

    const androidPath = "apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewaySession.kt";
    const android = await readRepoFile(androidPath);
    assertPattern(
      android,
      androidPath,
      /put\("minProtocol", JsonPrimitive\(GATEWAY_MIN_PROTOCOL_VERSION\)\)/,
      "connect params must advertise GATEWAY_MIN_PROTOCOL_VERSION as minProtocol.",
    );
    assertPattern(
      android,
      androidPath,
      /put\("maxProtocol", JsonPrimitive\(GATEWAY_PROTOCOL_VERSION\)\)/,
      "connect params must advertise GATEWAY_PROTOCOL_VERSION as maxProtocol.",
    );
  });
});
