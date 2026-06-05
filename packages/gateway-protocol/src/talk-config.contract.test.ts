// Gateway Protocol tests cover talk config.contract behavior.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTalkConfigResponse } from "../../../src/config/talk.js";
import { validateTalkConfigResult } from "./index.js";

/**
 * Talk config contract tests shared between config normalization and gateway
 * protocol validation. Fixtures capture provider selection and timeout behavior
 * so config changes cannot silently diverge from the public RPC response shape.
 */

/** Expected resolved provider/config selection for one fixture case. */
type ExpectedSelection = {
  provider: string;
  normalizedPayload: boolean;
  voiceId?: string;
  apiKey?: string;
};

/** Fixture row that validates normalized Talk provider selection. */
type SelectionContractCase = {
  id: string;
  defaultProvider: string;
  payloadValid: boolean;
  expectedSelection: ExpectedSelection | null;
  talk: Record<string, unknown>;
};

/** Fixture row that validates Talk silence-timeout normalization. */
type TimeoutContractCase = {
  id: string;
  fallback: number;
  expectedTimeoutMs: number;
  talk: Record<string, unknown>;
};

/** JSON fixture file shape used by this contract test. */
type TalkConfigContractFixture = {
  selectionCases: SelectionContractCase[];
  timeoutCases: TimeoutContractCase[];
};

/** External fixture keeps the matrix readable and reusable across config edits. */
const fixturePath = new URL("../../../test/fixtures/talk-config-contract.json", import.meta.url);
const fixtures = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as TalkConfigContractFixture;

describe("talk.config contract fixtures", () => {
  for (const fixture of fixtures.selectionCases) {
    it(fixture.id, () => {
      const payload = { config: { talk: buildTalkConfigResponse(fixture.talk) } };
      if (fixture.payloadValid) {
        expect(validateTalkConfigResult(payload)).toBe(true);
      } else {
        expect(validateTalkConfigResult(payload)).toBe(false);
      }

      if (!fixture.expectedSelection) {
        return;
      }

      const talk = payload.config.talk as
        | {
            resolved?: {
              provider?: string;
              config?: {
                voiceId?: string;
                apiKey?: string;
              };
            };
          }
        | undefined;
      expect(talk?.resolved?.provider ?? fixture.defaultProvider).toBe(
        fixture.expectedSelection.provider,
      );
      expect(talk?.resolved?.config?.voiceId).toBe(fixture.expectedSelection.voiceId);
      expect(talk?.resolved?.config?.apiKey).toBe(fixture.expectedSelection.apiKey);
    });
  }

  for (const fixture of fixtures.timeoutCases) {
    it(`timeout:${fixture.id}`, () => {
      const payload = buildTalkConfigResponse(fixture.talk);
      expect(payload?.silenceTimeoutMs ?? fixture.fallback).toBe(fixture.expectedTimeoutMs);
    });
  }
});
