import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDecisionRecord, renderDecisionMarkdown } from "../scripts/charrette-lib.mjs";
import { sha256 } from "../scripts/json-utils.mjs";
import { fixtureCase, rebind } from "./test-helpers.mjs";

const requiredRecordSections = [
  "# Scoped Architecture Decision Record",
  "## Outcome",
  "## Scope and frozen question",
  "## Authority and claim boundary",
  "## Roles and review custody",
  "## Frozen evidence metadata",
  "## Frozen gates and results",
  "## Independent reviewer findings",
  "## Objections and derived dispositions",
  "## Challenges and repair",
  "## Contradictions and dissent",
  "## Final independent review",
  "## Next authorized action",
  "## Integrity",
];

const requiredBindingLabels = [
  "- Operation ID:",
  "- Target scope ID:",
  "- Immutable operation parameters:",
  "- Evaluator ID:",
  "- Accepted resolution IDs:",
  "- Delegated mission:",
  "- Decision context digest:",
  "- Target scope kind:",
  "- Target repository:",
  "- Target workspace:",
];

test("renders a complete operator-facing S.ADR without raw evidence content", () => {
  const { session, findings } = fixtureCase("proceed");
  const record = createDecisionRecord(session, findings);
  const markdown = renderDecisionMarkdown(record);

  let previousIndex = -1;
  for (const section of requiredRecordSections) {
    const sectionIndex = markdown.indexOf(section);
    assert.ok(sectionIndex > previousIndex, `missing or misordered section: ${section}`);
    previousIndex = sectionIndex;
  }
  for (const label of requiredBindingLabels) {
    assert.ok(markdown.includes(label), `missing required S.ADR binding: ${label}`);
  }

  assert.match(markdown, /Terminal decision: \*\*PROCEED\*\*/);
  assert.match(markdown, /Result status: PASS/);
  assert.match(markdown, /#### Fact findings/);
  assert.match(markdown, /Analysis summary:/);
  assert.match(markdown, /Status: ACCEPTED/);
  assert.match(markdown, /Raw evidence content is intentionally omitted/);
  assert.match(markdown, new RegExp(record.integrity_digest));

  for (const item of session.evidence) {
    assert.match(markdown, new RegExp(item.sha256));
    assert.equal(
      markdown.includes(item.content),
      false,
      `raw evidence content leaked for ${item.id}`,
    );
  }
});

test("layout reference is non-executable and stays in section parity with the safe renderer", () => {
  const layout = readFileSync(
    new URL("../assets/templates/decision-record.md", import.meta.url),
    "utf8",
  );

  assert.match(layout, /audit map, not a fillable template/i);
  assert.match(layout, /Never copy it and replace\s+field names by hand/);
  assert.doesNotMatch(layout, /\{\{[^}]+\}\}/);

  for (const section of requiredRecordSections.slice(1)) {
    assert.ok(layout.includes(section), `layout reference is missing section: ${section}`);
  }
  for (const binding of [
    "reason_codes",
    "proof_bar",
    "operation_id",
    "target_scope_id",
    "parameters",
    "decision_context_digest",
    "target_scope.repository_id",
    "cross_review_started_at",
    "evaluator_id",
    "challenge_rounds",
    "accepted_resolution_ids",
    "blocking_objections",
    "integrity_digest",
  ]) {
    assert.ok(layout.includes(binding), `layout reference is missing binding: ${binding}`);
  }
});

test("renders objections, derived dispositions, challenges, contradictions, and dissent", () => {
  const { session, findings } = fixtureCase("proceed");
  const objection = {
    id: "objection-render",
    code: "UNSUPPORTED_CLAIM",
    severity: "advisory",
    correctable: true,
    statement: "The claim needs one explicit citation.",
    evidence_ids: ["ev-tests"],
  };
  const contradiction = {
    id: "contradiction-render",
    severity: "advisory",
    statement: "The advisory interpretation remains unresolved.",
    evidence_ids: ["ev-tests"],
  };
  findings.reviews[0].objections = [objection];
  findings.reviews[0].contradictions = [contradiction];
  findings.reviews[0].dissent = ["Preserve the minority recommendation."];
  findings.unresolved_contradictions = [structuredClone(contradiction)];
  findings.challenge_rounds = 1;
  findings.challenges = [
    {
      round: 1,
      finding_id: objection.id,
      challenge: "Frozen evidence resolves this advisory objection.",
      disposition: "resolved",
      evidence_ids: ["ev-tests"],
    },
  ];
  findings.final_review.accepted_resolution_ids = [objection.id];
  rebind(session, findings);

  const markdown = renderDecisionMarkdown(createDecisionRecord(session, findings));

  assert.match(markdown, /disposition: resolved/);
  assert.match(markdown, /Round 1; finding objection\\-render; disposition resolved/);
  assert.match(markdown, /The advisory interpretation remains unresolved/);
  assert.match(markdown, /Preserve the minority recommendation/);
});

test("escapes hostile Markdown, HTML, remote images, links, and line breaks", () => {
  const { session, findings } = fixtureCase("proceed");
  const hostile =
    '![remote](https://example.invalid/pixel.png) <img src="https://example.invalid/x"> ' +
    "[click](javascript:alert(1))\n# injected\n| cell | <script>alert(1)</script>";
  const secretEvidence =
    "SECRET_EVIDENCE_PAYLOAD ![evidence-beacon](https://example.invalid/secret.png)";

  session.mission_statement = hostile;
  session.decision.question = hostile;
  session.decision.options[0].summary = hostile;
  session.evidence.push({
    id: "ev-hostile-render",
    kind: "inline_fixture",
    source: hostile,
    sha256: sha256(secretEvidence),
    classification: "other",
    untrusted: true,
    encoding: "utf8",
    content: secretEvidence,
  });
  findings.reviews[0].analysis_summary = hostile;
  findings.reviews[0].observations[0].statement = hostile;
  findings.reviews[0].uncertainty = [hostile];
  findings.reviews[0].falsifiers = [hostile];
  findings.reviews[0].dissent = [hostile];
  findings.gate_results[0].explanation = hostile;
  rebind(session, findings);

  const record = createDecisionRecord(session, findings);
  const markdown = renderDecisionMarkdown(record);

  assert.equal(markdown.includes(secretEvidence), false);
  assert.equal(markdown.includes("SECRET_EVIDENCE_PAYLOAD"), false);
  assert.doesNotMatch(markdown, /!\[remote\]\(/);
  assert.doesNotMatch(markdown, /<img\b/i);
  assert.doesNotMatch(markdown, /<script\b/i);
  assert.doesNotMatch(markdown, /\]\(javascript:/i);
  assert.doesNotMatch(markdown, /\n# injected/);
  assert.doesNotMatch(markdown, /https:\/\/example\.invalid\/pixel\.png/);
  assert.match(markdown, /\\!\\\[remote\\\]/);
  assert.match(markdown, /&lt;img/);
  assert.match(markdown, /javascript&#58;/);
  assert.equal(renderDecisionMarkdown(record), markdown);
});

test("sanitizes C1 control and bidi formatting characters", () => {
  const { session, findings } = fixtureCase("proceed");
  session.mission_statement = "visible\u009bhidden\u202ereordered";
  rebind(session, findings);

  const markdown = renderDecisionMarkdown(createDecisionRecord(session, findings));

  assert.equal(markdown.includes("\u009b"), false);
  assert.equal(markdown.includes("\u202e"), false);
  assert.match(markdown, /visible\ufffdhidden\ufffdreordered/);
});
