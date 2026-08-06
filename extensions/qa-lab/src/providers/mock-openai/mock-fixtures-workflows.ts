import type { MockFixture, MockFixturePlan } from "./mock-fixtures.js";

function fixture(
  id: string,
  match: MockFixture["match"],
  respond: MockFixture["respond"],
): MockFixture {
  return { id, match, respond };
}
// Ordered scenario fixtures for the QA Lab mock Responses provider.
import * as contract from "./mock-openai-contracts.js";
import { buildReleaseAuditJson, buildReleaseHandoffMarkdown } from "./mock-openai-events.js";
import {
  extractAllToolOutputText,
  extractUserTextAfterLatestToolOutput,
} from "./mock-openai-input.js";
import {
  extractOrbitCode,
  extractSnackPreference,
  isActiveMemorySubagentPrompt,
  isSnackRecallPrompt,
} from "./mock-openai-tooling.js";

const reply = (text: string): MockFixturePlan => ({ kind: "reply", text });
const tool = (name: string, args: Record<string, unknown>, raw = false): MockFixturePlan => ({
  kind: "tool",
  name,
  args,
  ...(raw ? { raw: true } : {}),
});
export const MOCK_OPENAI_FIXTURES_WORKFLOWS: readonly MockFixture[] = [
  fixture(
    "skill-workshop-review",
    (context) => contract.QA_SKILL_WORKSHOP_REVIEW_PROMPT_RE.test(context.allInputText),
    () =>
      reply(
        JSON.stringify({
          action: "create",
          skillName: "animated-gif-workflow",
          title: "Animated GIF Workflow",
          reason: "Transcript captured a reusable animated media QA checklist.",
          description: "Reusable workflow notes for animated GIF QA tasks.",
          body: [
            "- Confirm the asset has true animation, not a static preview.",
            "- Check dimensions against the target product UI slot.",
            "- Record attribution and license before using the file.",
            "- Keep a local copy under the workspace before integration.",
            "- Re-open the local copy for final verification.",
          ].join("\n"),
        }),
      ),
  ),
  fixture(
    "skill-workshop-gif",
    (context) =>
      contract.QA_SKILL_WORKSHOP_GIF_PROMPT_RE.test(context.prompt) &&
      !context.hasCompletedToolOutput,
    () =>
      tool("write", {
        path: "animated-gif-qa-checklist.md",
        content: [
          "# Animated GIF QA Checklist",
          "",
          "- Confirm true animation.",
          "- Verify dimensions.",
          "- Record attribution.",
          "- Keep a local copy.",
          "- Perform final verification.",
        ].join("\n"),
      }),
  ),
  fixture(
    "release-audit",
    (context) => contract.QA_RELEASE_AUDIT_PROMPT_RE.test(context.prompt),
    (context) => {
      if (!context.hasCompletedToolOutput) {
        return tool("read", { path: "audit-fixture/README.md" });
      }
      if (/Release readiness task|current checklist/i.test(context.toolOutput)) {
        return tool("read", { path: "audit-fixture/docs/current-readiness-checklist.md" });
      }
      if (/Current release readiness requires checking eight areas/i.test(context.toolOutput)) {
        return tool("write", {
          path: "audit-fixture/release-audit.json",
          content: buildReleaseAuditJson(),
        });
      }
      if (/release-audit\.json/i.test(context.toolOutput)) {
        return tool("write", {
          path: "audit-fixture/release-handoff.md",
          content: buildReleaseHandoffMarkdown(),
        });
      }
      return /release-handoff\.md/i.test(context.toolOutput)
        ? reply("RELEASE-AUDIT-COMPLETE")
        : undefined;
    },
  ),
  fixture(
    "personal-share-safe-diagnostics",
    (context) => contract.QA_PERSONAL_SHARE_SAFE_DIAGNOSTICS_PROMPT_RE.test(context.allInputText),
    (context) => {
      const evidence = extractAllToolOutputText(context.input);
      if (/successfully (?:wrote|created|updated|replaced)/i.test(evidence)) {
        return reply(
          [
            "Artifact: personal-diagnostics-summary.txt",
            "Status: share-safe diagnostics summary ready",
            "PERSONAL-DIAGNOSTICS-SAFE-OK",
          ].join("\n"),
        );
      }
      if (
        !evidence ||
        (!evidence.includes("# Personal diagnostics request") &&
          !evidence.includes("# Raw personal diagnostics fixture"))
      ) {
        return tool("read", { path: "DIAGNOSTICS_REQUEST.md" });
      }
      if (
        evidence.includes("# Personal diagnostics request") &&
        evidence.includes("# Raw personal diagnostics fixture")
      ) {
        return tool("write", {
          path: "personal-diagnostics-summary.txt",
          content: [
            "Status: blocked waiting for explicit publish approval",
            "Affected surface: telegram direct message",
            "Omitted content: raw chat text, raw tool output, account id, message id, and fake secret",
            "Redaction confirmed: yes",
            "Next step: ask maintainer whether manually landed commits can count for contributor credit",
          ].join("\n"),
        });
      }
      return evidence.includes("# Personal diagnostics request")
        ? tool("read", { path: "PERSONAL_DIAGNOSTICS_RAW.md" })
        : undefined;
    },
  ),
  fixture(
    "personal-no-fake-progress",
    (context) => contract.QA_PERSONAL_NO_FAKE_PROGRESS_PROMPT_RE.test(context.allInputText),
    (context) => {
      const evidence = [
        extractAllToolOutputText(context.input),
        extractUserTextAfterLatestToolOutput(context.input),
      ]
        .filter(Boolean)
        .join("\n");
      if (/successfully (?:wrote|created|updated|replaced)/i.test(evidence)) {
        return reply(
          [
            "Artifact: personal-progress-proof.txt",
            "Status: local proof artifact written",
            "External status: not sent, not published, not uploaded, not merged",
            "PERSONAL-NO-FAKE-PROGRESS-OK",
          ].join("\n"),
        );
      }
      if (
        !evidence ||
        (!evidence.includes("# Progress request") && !evidence.includes("# Progress evidence"))
      ) {
        return tool("read", { path: "PROGRESS_REQUEST.md" });
      }
      if (evidence.includes("# Progress request") && evidence.includes("# Progress evidence")) {
        return tool("write", {
          path: "personal-progress-proof.txt",
          content: [
            "Personal no-fake-progress",
            "Status: local proof artifact written",
            "External status: not sent; not published; not uploaded; not merged",
            "Evidence: PROGRESS_REQUEST.md and PROGRESS_EVIDENCE.md were read before this artifact was written",
          ].join("\n"),
        });
      }
      return evidence.includes("# Progress request")
        ? tool("read", { path: "PROGRESS_EVIDENCE.md" })
        : undefined;
    },
  ),
  fixture(
    "personal-failure-recovery",
    (context) => contract.QA_PERSONAL_FAILURE_RECOVERY_PROMPT_RE.test(context.allInputText),
    (context) => {
      const evidence = [
        extractAllToolOutputText(context.input),
        extractUserTextAfterLatestToolOutput(context.input),
      ]
        .filter(Boolean)
        .join("\n");
      if (/successfully (?:wrote|created|updated|replaced)/i.test(evidence)) {
        return reply(
          [
            "Artifact: personal-failure-recovery.txt",
            "Failed step: external calendar update was not attempted",
            "Retry boundary: do not retry until approval is given",
            "PERSONAL-FAILURE-RECOVERY-OK",
          ].join("\n"),
        );
      }
      if (
        !evidence ||
        (!evidence.includes("# Failure recovery request") &&
          !evidence.includes("# Failure recovery evidence"))
      ) {
        return tool("read", { path: "FAILURE_RECOVERY_REQUEST.md" });
      }
      if (
        evidence.includes("# Failure recovery request") &&
        evidence.includes("# Failure recovery evidence")
      ) {
        return tool("write", {
          path: "personal-failure-recovery.txt",
          content: [
            "Personal failure recovery",
            "Completed: request reviewed and local evidence captured",
            "Failed step: external calendar update was not attempted because explicit approval is missing",
            "Retry boundary: do not retry the external step until approval is given",
            "Next step: ask for approval before any external update",
          ].join("\n"),
        });
      }
      return evidence.includes("# Failure recovery request")
        ? tool("read", { path: "FAILURE_RECOVERY_EVIDENCE.md" })
        : undefined;
    },
  ),
  fixture(
    "lobster-invaders",
    (context) => contract.QA_LOBSTER_INVADERS_PROMPT_RE.test(context.prompt),
    (context) => {
      if (!context.hasCompletedToolOutput) {
        return tool("read", { path: "QA_KICKOFF_TASK.md" });
      }
      return context.toolOutput.includes("QA mission") || context.toolOutput.includes("Testing")
        ? tool("write", {
            path: "lobster-invaders.html",
            content: `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Lobster Invaders</title></head>
  <body><h1>Lobster Invaders</h1><p>Tiny playable stub.</p></body>
</html>`,
          })
        : undefined;
    },
  ),
  fixture(
    "memory-tools",
    (context) => contract.QA_MEMORY_TOOLS_PROMPT_RE.test(context.allInputText),
    (context) => {
      if (!context.scenarioToolOutput) {
        return tool("memory_search", { query: "hidden project codename", maxResults: 3 });
      }
      const results = Array.isArray(context.toolJson?.results)
        ? (context.toolJson.results as Array<Record<string, unknown>>)
        : [];
      const first = results[0];
      if (typeof first?.path !== "string") {
        return undefined;
      }
      const from =
        typeof first.startLine === "number"
          ? Math.max(1, first.startLine)
          : typeof first.endLine === "number"
            ? Math.max(1, first.endLine)
            : 1;
      return tool("memory_get", { path: first.path, from, lines: 4 });
    },
  ),
  fixture(
    "snack-memory",
    (context) =>
      isActiveMemorySubagentPrompt(context.allInputText) &&
      isSnackRecallPrompt(context.allInputText),
    (context) => {
      if (!context.hasCompletedToolOutput) {
        return !context.hasDeclaredTool("memory_recall")
          ? tool("memory_search", {
              query: "QA movie night snack lemon pepper wings blue cheese",
              maxResults: contract.QA_REMEMBER_ACROSS_CONVERSATIONS_PROMPT_RE.test(
                context.allInputText,
              )
                ? 10
                : 3,
            })
          : tool("memory_recall", {
              query: "QA movie night snack lemon pepper wings blue cheese",
              limit: 3,
            });
      }
      const memoryText =
        typeof context.toolJson?.text === "string"
          ? context.toolJson.text
          : Array.isArray(context.toolJson?.content)
            ? context.toolJson.content
                .map((item) =>
                  typeof item === "object" &&
                  item &&
                  "text" in item &&
                  typeof item.text === "string"
                    ? item.text
                    : "",
                )
                .filter(Boolean)
                .join("\n")
            : undefined;
      if (memoryText) {
        const preference = extractSnackPreference(memoryText);
        return reply(preference ? `User usually wants ${preference} for QA movie night.` : "NONE");
      }
      const results = Array.isArray(context.toolJson?.results)
        ? (context.toolJson.results as Array<Record<string, unknown>>)
        : [];
      const first = results[0];
      if (typeof first?.path === "string" && context.hasDeclaredTool("memory_get")) {
        const from =
          typeof first.startLine === "number"
            ? Math.max(1, first.startLine)
            : typeof first.endLine === "number"
              ? Math.max(1, first.endLine)
              : 1;
        return tool("memory_get", { path: first.path, from, lines: 4 });
      }
      const snippet = Array.isArray(context.toolJson?.results)
        ? JSON.stringify(context.toolJson.results)
        : context.toolOutput;
      const preference = extractSnackPreference(snippet);
      return reply(preference ? `User usually wants ${preference} for QA movie night.` : "NONE");
    },
  ),
  fixture(
    "session-memory-ranking",
    (context) => contract.QA_SESSION_MEMORY_RANKING_PROMPT_RE.test(context.prompt),
    (context) => {
      if (!context.scenarioToolOutput) {
        return tool("memory_search", { query: "current Project Nebula codename", maxResults: 6 });
      }
      if (
        context.toolJson?.unavailable === true ||
        context.toolJson?.disabled === true ||
        (typeof context.toolJson?.error === "string" && context.toolJson.error.trim().length > 0)
      ) {
        return reply("NONE");
      }
      const results = Array.isArray(context.toolJson?.results)
        ? (context.toolJson.results as Array<Record<string, unknown>>)
        : [];
      const preferred = results.find((result) => {
        const path = typeof result.path === "string" ? result.path : undefined;
        if (result.source !== "sessions" && !path?.startsWith("sessions/")) {
          return false;
        }
        const text =
          typeof result.snippet === "string"
            ? result.snippet
            : typeof result.text === "string"
              ? result.text
              : "";
        return extractOrbitCode(text) !== null;
      });
      const preferredText =
        typeof preferred?.snippet === "string"
          ? preferred.snippet
          : typeof preferred?.text === "string"
            ? preferred.text
            : "";
      const code =
        extractOrbitCode(preferredText) ??
        (typeof context.toolJson?.text === "string"
          ? extractOrbitCode(context.toolJson.text)
          : null);
      if (code) {
        return reply(
          `Protocol note: I checked memory and the current Project Nebula codename is ${code}.`,
        );
      }
      const first =
        results.find((result) => {
          const path = typeof result.path === "string" ? result.path : undefined;
          return result.source === "sessions" || path?.startsWith("sessions/");
        }) ?? results[0];
      if (
        typeof first?.path === "string" &&
        (typeof first.startLine === "number" || typeof first.endLine === "number")
      ) {
        const from =
          typeof first.startLine === "number"
            ? Math.max(1, first.startLine)
            : typeof first.endLine === "number"
              ? Math.max(1, first.endLine)
              : 1;
        return tool("memory_get", { path: first.path, from, lines: 4 });
      }
      return reply("NONE");
    },
  ),
] as const;
