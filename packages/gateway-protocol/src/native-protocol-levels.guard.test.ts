// Gateway Protocol tests cover native protocol levels.guard behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, it } from "vitest";
import { ProtocolSchemas } from "./schema/protocol-schemas.js";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  MIN_NODE_PROTOCOL_VERSION,
  MIN_PROBE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "./version.js";

/**
 * Cross-language guard for Gateway protocol version constants.
 *
 * Native Swift/Kotlin clients and dev smoke scripts cannot derive these values
 * from TypeScript at runtime, so this test keeps checked-in generated constants
 * and connect payloads aligned with the package source of truth.
 */

/** Min/max protocol pair expected in a native client surface. */
type ProtocolLevels = {
  min: number;
  max: number;
};

const expectedClientLevels: ProtocolLevels = {
  min: MIN_CLIENT_PROTOCOL_VERSION,
  max: PROTOCOL_VERSION,
};

const expectedNodeLevels: ProtocolLevels = {
  min: MIN_NODE_PROTOCOL_VERSION,
  max: PROTOCOL_VERSION,
};

/** Reads a repo-relative source file used by a native protocol guard. */
async function readRepoFile(relativePath: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), relativePath), "utf8");
}

/** Extracts one integer constant and reports the owning file on drift. */
function extractInteger(
  content: string,
  pattern: RegExp,
  relativePath: string,
  label: string,
): number {
  const match = pattern.exec(content);
  if (!match) {
    throw new Error(
      `${relativePath}: missing ${label}; keep native Gateway protocol levels in sync with packages/gateway-protocol/src/version.ts.`,
    );
  }
  return Number.parseInt(expectDefined(match[1], "match[1] test invariant"), 10);
}

/** Compares native min/max values to the TypeScript version constants. */
function assertLevelsMatch(
  relativePath: string,
  actual: ProtocolLevels,
  expected: ProtocolLevels = expectedClientLevels,
): void {
  if (actual.min === expected.min && actual.max === expected.max) {
    return;
  }
  throw new Error(
    `${relativePath}: Gateway protocol level mismatch: expected min=${expected.min} max=${expected.max} from packages/gateway-protocol/src/version.ts, got min=${actual.min} max=${actual.max}. Update the native constants/generated artifacts before shipping.`,
  );
}

/** Asserts a compatibility pattern exists in generated/native source text. */
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

function stringLiteralUnionValues(schema: unknown): string[] | undefined {
  if (!schema || typeof schema !== "object") {
    return undefined;
  }
  const candidate = schema as { anyOf?: unknown; oneOf?: unknown };
  const branches = candidate.oneOf ?? candidate.anyOf;
  if (!Array.isArray(branches) || branches.length === 0) {
    return undefined;
  }

  const values: string[] = [];
  for (const branch of branches) {
    if (!branch || typeof branch !== "object" || !("const" in branch)) {
      return undefined;
    }
    const value = branch.const;
    if (typeof value !== "string") {
      return undefined;
    }
    values.push(value);
  }
  return new Set(values).size === values.length ? values : undefined;
}

describe("native Gateway protocol levels", () => {
  it("match the TypeScript source of truth", async () => {
    if (MIN_CLIENT_PROTOCOL_VERSION > PROTOCOL_VERSION) {
      throw new Error(
        `packages/gateway-protocol/src/version.ts: MIN_CLIENT_PROTOCOL_VERSION (${MIN_CLIENT_PROTOCOL_VERSION}) must not exceed PROTOCOL_VERSION (${PROTOCOL_VERSION}).`,
      );
    }
    if (
      MIN_NODE_PROTOCOL_VERSION !== PROTOCOL_VERSION - 1 ||
      MIN_PROBE_PROTOCOL_VERSION !== PROTOCOL_VERSION - 1
    ) {
      throw new Error(
        "packages/gateway-protocol/src/version.ts: node and probe compatibility must remain exactly N-1.",
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
    assertLevelsMatch(
      swiftGeneratedPath,
      {
        min: extractInteger(
          swiftGenerated,
          /public let GATEWAY_MIN_NODE_PROTOCOL_VERSION = (\d+)/,
          swiftGeneratedPath,
          "GATEWAY_MIN_NODE_PROTOCOL_VERSION",
        ),
        max: extractInteger(
          swiftGenerated,
          /public let GATEWAY_PROTOCOL_VERSION = (\d+)/,
          swiftGeneratedPath,
          "GATEWAY_PROTOCOL_VERSION",
        ),
      },
      expectedNodeLevels,
    );

    const androidPath = "apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewayProtocol.kt";
    const android = await readRepoFile(androidPath);
    assertLevelsMatch(
      androidPath,
      {
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
      },
      expectedNodeLevels,
    );
  });

  it("uses the min constant for native connect compatibility ranges", async () => {
    const swiftChannelPath = "apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayChannel.swift";
    const swiftChannel = await readRepoFile(swiftChannelPath);
    assertPattern(
      swiftChannel,
      swiftChannelPath,
      /if role == "node", clientMode == "node" \{\s+return GATEWAY_MIN_NODE_PROTOCOL_VERSION\s+\}\s+return GATEWAY_MIN_PROTOCOL_VERSION/,
      "node connections must use the node compatibility floor without changing operator clients.",
    );
    assertPattern(
      swiftChannel,
      swiftChannelPath,
      /"minProtocol": ProtoAnyCodable\(minProtocol\)/,
      "connect params must advertise the role-specific minimum as minProtocol.",
    );
    assertPattern(
      swiftChannel,
      swiftChannelPath,
      /"maxProtocol": ProtoAnyCodable\(GATEWAY_PROTOCOL_VERSION\)/,
      "connect params must advertise GATEWAY_PROTOCOL_VERSION as maxProtocol.",
    );

    const watchPath = "apps/ios/WatchApp/Sources/WatchDirectNode.swift";
    const watch = await readRepoFile(watchPath);
    assertPattern(
      watch,
      watchPath,
      /minprotocol: GATEWAY_MIN_PROTOCOL_VERSION/,
      "Direct Watch HTTP connects must keep the current client protocol floor.",
    );
    assertPattern(
      watch,
      watchPath,
      /maxprotocol: GATEWAY_PROTOCOL_VERSION/,
      "Watch node connects must advertise GATEWAY_PROTOCOL_VERSION as maxProtocol.",
    );

    const swiftWizardPath = "apps/macos/Sources/OpenClawMacCLI/WizardCommand.swift";
    const swiftWizard = await readRepoFile(swiftWizardPath);
    assertPattern(
      swiftWizard,
      swiftWizardPath,
      /"minProtocol": ProtoAnyCodable\(GATEWAY_MIN_PROTOCOL_VERSION\)/,
      "operator connects must advertise GATEWAY_MIN_PROTOCOL_VERSION as minProtocol.",
    );
    assertPattern(
      swiftWizard,
      swiftWizardPath,
      /"maxProtocol": ProtoAnyCodable\(GATEWAY_PROTOCOL_VERSION\)/,
      "operator connects must advertise GATEWAY_PROTOCOL_VERSION as maxProtocol.",
    );

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

  it("uses the TypeScript source of truth for dev Gateway smoke scripts", async () => {
    const devScripts = ["scripts/dev/gateway-smoke.ts", "scripts/dev/ios-node-e2e.ts"];
    for (const relativePath of devScripts) {
      const content = await readRepoFile(relativePath);
      assertPattern(
        content,
        relativePath,
        /MIN_CLIENT_PROTOCOL_VERSION/,
        "connect params must import/use MIN_CLIENT_PROTOCOL_VERSION as minProtocol.",
      );
      assertPattern(
        content,
        relativePath,
        /PROTOCOL_VERSION/,
        "connect params must import/use PROTOCOL_VERSION as maxProtocol.",
      );
      assertPattern(
        content,
        relativePath,
        /minProtocol:\s*MIN_CLIENT_PROTOCOL_VERSION/,
        "connect params must advertise MIN_CLIENT_PROTOCOL_VERSION as minProtocol.",
      );
      assertPattern(
        content,
        relativePath,
        /maxProtocol:\s*PROTOCOL_VERSION/,
        "connect params must advertise PROTOCOL_VERSION as maxProtocol.",
      );
    }
  });

  it("emits named string-literal unions as Swift enums", async () => {
    const swiftGeneratedPath =
      "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift";
    const swiftGenerated = await readRepoFile(swiftGeneratedPath);

    for (const [name, schema] of Object.entries(ProtocolSchemas)) {
      const values = stringLiteralUnionValues(schema);
      if (!values) {
        continue;
      }

      const enumStart = `public enum ${name}: String, Codable, Sendable {`;
      const start = swiftGenerated.indexOf(enumStart);
      if (start < 0) {
        throw new Error(`${swiftGeneratedPath}: missing Swift enum for ${name}.`);
      }
      const end = swiftGenerated.indexOf("\n}\n", start);
      const enumSource = swiftGenerated.slice(start, end);
      for (const value of values) {
        assertPattern(
          enumSource,
          swiftGeneratedPath,
          new RegExp(`= ${JSON.stringify(value)}$`, "m"),
          `${name} must include the ${JSON.stringify(value)} literal.`,
        );
      }
    }
  });

  it("emits the session approval event as a discriminated Swift union", async () => {
    const swiftGeneratedPath =
      "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift";
    const swiftGenerated = await readRepoFile(swiftGeneratedPath);

    assertPattern(
      swiftGenerated,
      swiftGeneratedPath,
      /public enum SessionApprovalEvent: Codable, Sendable \{/,
      "missing the generated SessionApprovalEvent union.",
    );
    assertPattern(
      swiftGenerated,
      swiftGeneratedPath,
      /case pending\(PendingSessionApprovalEvent\)/,
      "SessionApprovalEvent must decode pending transitions.",
    );
    assertPattern(
      swiftGenerated,
      swiftGeneratedPath,
      /case terminal\(TerminalSessionApprovalEvent\)/,
      "SessionApprovalEvent must decode terminal transitions.",
    );
  });
});
