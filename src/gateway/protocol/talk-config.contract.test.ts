import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTalkConfigResponse } from "../../config/talk.js";
import { validateTalkConfigResult } from "./index.js";

type ExpectedSelection = {
  provider: string;
  normalizedPayload: boolean;
  voiceId?: string;
  apiKey?: string;
};

type SelectionContractCase = {
  id: string;
  defaultProvider: string;
  payloadValid: boolean;
  expectedSelection: ExpectedSelection | null;
  talk: Record<string, unknown>;
};

type TimeoutContractCase = {
  id: string;
  fallback: number;
  expectedTimeoutMs: number;
  talk: Record<string, unknown>;
};

type TalkConfigContractFixture = {
  selectionCases: SelectionContractCase[];
  timeoutCases: TimeoutContractCase[];
};

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
