import { describe, expect, it } from "vitest";
import type { QuestionRequestQuestion } from "../../../packages/gateway-protocol/src/index.js";
import {
  listSecretStoreEntries,
  readSecretStoreValue,
  writeSecretStoreEntry,
} from "../../secrets/store/secret-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  broadcast,
  callQuestionRpc as call,
  installQuestionTestHooks,
  manager,
  requestSecretQuestion,
} from "./question.test-support.js";

installQuestionTestHooks();

type SecretBinding = NonNullable<QuestionRequestQuestion["secretStore"]>;
const binding: SecretBinding = { name: "SERVICE_API_KEY", kind: "secret" };
const hostA = ["a.example.test"];
const hostB = ["b.example.test"];
const hostC = ["c.example.test"];
const existingSecret = { kind: "secret", allowedHosts: hostA } satisfies Pick<
  SecretBinding,
  "kind" | "allowedHosts"
>;

describe("question host consent", () => {
  it.each<{
    scenario: string;
    existing?: Pick<SecretBinding, "kind" | "allowedHosts">;
    proposal?: string[];
    override?: string[];
    shown: string[];
    saved: string[];
  }>([
    { scenario: "missing entry, omitted proposal", shown: [], saved: [] },
    {
      scenario: "replacement, omitted proposal",
      existing: existingSecret,
      shown: hostA,
      saved: hostA,
    },
    {
      scenario: "replacement, empty proposal",
      existing: existingSecret,
      proposal: [],
      shown: [],
      saved: [],
    },
    {
      scenario: "replacement, changed proposal",
      existing: existingSecret,
      proposal: hostB,
      shown: hostB,
      saved: hostB,
    },
    {
      scenario: "replacement, human clear",
      existing: existingSecret,
      override: [],
      shown: hostA,
      saved: [],
    },
    {
      scenario: "replacement, human edit",
      existing: existingSecret,
      override: hostC,
      shown: hostA,
      saved: hostC,
    },
    { scenario: "unbound replacement", existing: { kind: "secret" }, shown: [], saved: [] },
    { scenario: "env-to-secret replacement", existing: { kind: "env" }, shown: [], saved: [] },
  ])(
    "shows and saves the consented policy: $scenario",
    async ({ existing, proposal, override, shown, saved }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const oldValue = "test-secret-value-existing-123";
        if (existing) {
          writeSecretStoreEntry({
            scope: { kind: "team" },
            name: binding.name,
            value: oldValue,
            updatedBy: "Previous Operator",
            ...existing,
          });
        }
        const id = await requestSecretQuestion({
          ...binding,
          ...(proposal !== undefined ? { allowedHosts: proposal } : {}),
        });
        const question = {
          secretStore: { ...binding, allowedHosts: shown },
          ...(existing
            ? { secretStoreExisting: { updatedAtMs: 1_000, updatedBy: "Previous Operator" } }
            : {}),
        };
        expect(broadcast).toHaveBeenCalledWith(
          "question.requested",
          expect.objectContaining({ id, questions: [expect.objectContaining(question)] }),
        );
        const displayed = await call("question.get", { id });
        expect(displayed).toMatchObject([true, { question: { questions: [question] } }, undefined]);
        expect(JSON.stringify(displayed)).not.toContain(oldValue);
        if (!existing) {
          expect(manager.get(id)?.questions[0]).not.toHaveProperty("secretStoreExisting");
        }

        const value = "test-secret-consented-replacement";
        const resolved = await call("question.resolve", {
          id,
          answers: { answers: { secret_value: [value] } },
          ...(override !== undefined ? { secretStoreAllowedHosts: override } : {}),
        });
        const safeAnswers = { answers: { secret_value: ["stored"] } };
        expect(resolved).toEqual([true, { status: "answered", answers: safeAnswers }, undefined]);
        expect(manager.get(id)).toMatchObject({ status: "answered", answers: safeAnswers });
        expect(listSecretStoreEntries({ scope: { kind: "team" } })).toMatchObject([
          { name: binding.name, kind: "secret", allowedHosts: saved },
        ]);
        expect(readSecretStoreValue({ scope: { kind: "team" }, name: binding.name })).toEqual({
          ok: true,
          value,
        });
      });
    },
  );

  it.each([
    { scenario: "same-name entry created", existingHosts: undefined, shown: [] },
    { scenario: "existing hosts changed", existingHosts: hostA, shown: hostA },
  ])(
    "keeps the displayed policy when $scenario while pending",
    async ({ existingHosts, shown }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const entry = {
          scope: { kind: "team" as const },
          ...binding,
          value: "test-secret-concurrent",
          updatedBy: "Other Operator",
        };
        if (existingHosts) {
          writeSecretStoreEntry({ ...entry, allowedHosts: existingHosts });
        }
        const id = await requestSecretQuestion(binding);
        const displayed = await call("question.get", { id });
        writeSecretStoreEntry({ ...entry, allowedHosts: hostB });
        expect(listSecretStoreEntries({ scope: { kind: "team" } })[0]?.allowedHosts).toEqual(hostB);
        const resolved = await call("question.resolve", {
          id,
          answers: { answers: { secret_value: ["test-secret-consented-after-update"] } },
        });
        expect(resolved).toEqual([
          true,
          { status: "answered", answers: { answers: { secret_value: ["stored"] } } },
          undefined,
        ]);
        // Check the committed policy first so the pre-fix run proves the hidden inheritance.
        expect(listSecretStoreEntries({ scope: { kind: "team" } })[0]).toMatchObject({
          kind: "secret",
          allowedHosts: shown,
        });
        expect(displayed).toMatchObject([
          true,
          { question: { questions: [{ secretStore: { ...binding, allowedHosts: shown } }] } },
          undefined,
        ]);
      });
    },
  );
});
