import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Activity-only copy is registered when the lazy Activity page loads so the
// diagnostic inspector does not tax every Control UI startup.
const enActivity = {
  activity: {
    title: "Activity",
    visibleCount: "{visible} of {total}",
    search: "Search",
    searchPlaceholder: "Filter by activity, summary, run, session",
    toolFilter: "Tool",
    allTools: "All tools",
    statusFilters: "Status filters",
    autoFollow: "Auto-follow",
    expandAll: "Expand all",
    collapseAll: "Collapse all",
    clear: "Clear",
    empty: "No activity yet.",
    emptyFiltered: "No activity matches these filters.",
    entrySummary: "{argumentSummary}",
    argumentHiddenOne: "1 argument hidden",
    argumentsHidden: "{count} arguments hidden",
    streamLabel: "Agent activity entries",
    toolCallId: "Tool call",
    runId: "Run",
    session: "Session",
    outputTruncated: "Preview redacted and truncated.",
    noOutputPreview: "No output preview.",
    answerCandidate: {
      title: "Answer candidate",
      itemId: "Item",
      candidate: "Candidate answer",
      superseded: "Superseded answer",
      selected: "Selected answer",
    },
    status: {
      running: "Running",
      done: "Done",
      error: "Error",
    },
    subtitle: "Ephemeral agent activity derived from live session events.",
    runInspector: {
      activityView: "Activity view",
      liveMode: "Live activity",
      mode: "Run inspector",
      intro:
        "Durable Gateway-backed identity evidence for one run. Reloading this page queries the Gateway again.",
      bestEffortWarning:
        "Best-effort audit warning: this view is for operational diagnostics, not a lossless compliance record. Absence of evidence does not prove that an action or run did not occur.",
      evidenceStateLabel: "Evidence state: {state}",
      evidenceState: {
        present: "Present",
        absent: "Absent",
        unknown: "Unknown",
        unsupported: "Unsupported",
      },
      coverageStatusLabel: "Inspection coverage: {state}",
      coverage: {
        enforced: {
          label: "Enforced",
          description:
            "A decision receipt proves identity-aware evaluation; it does not by itself mean the action was allowed.",
        },
        attributionOnly: {
          label: "Attribution only",
          description:
            "Identity facts were recorded, but no identity-aware policy or grant evaluation is proven.",
        },
        unattributed: {
          label: "Unattributed",
          description: "The supported path was observed without a usable invoker principal.",
        },
        unknown: {
          label: "Unknown",
          description:
            "Expected evidence is missing, corrupt, expired unexpectedly, or unreadable.",
        },
        unsupported: {
          label: "Unsupported",
          description: "This path has no Phase 0 identity evidence contract.",
        },
      },
      facts: {
        trustDomain: "Trust domain",
        ingress: "Ingress",
        invoker: "Invoker",
        representedSubject: "Represented subject",
        sponsor: "Sponsor",
        agentPrincipal: "Agent principal",
        agentDefinition: "Agent definition",
        runtimeInstance: "Runtime instance",
        applicableGrants: "Applicable grants",
        applicableGrant: "Applicable grant {index}",
        assuranceEvidence: "Assurance evidence",
        assuranceEvidenceItem: "Assurance evidence {index}",
        lineage: "Lineage",
      },
      values: {
        label: "Label",
        kind: "Kind",
        principalReference: "Principal reference",
        domainReference: "Domain reference",
        owningBoundary: "Owning boundary",
        sourceReference: "Source reference",
        relationshipReference: "Relationship reference",
        definitionReference: "Definition reference",
        revisionReference: "Revision reference",
        runtimeReference: "Runtime reference",
        grantReference: "Grant reference",
        strength: "Strength",
        evidenceReference: "Evidence reference",
        depth: "Depth",
        parentRunReference: "Parent run reference",
        parentExecutionReference: "Parent execution reference",
        parentContextReference: "Parent context reference",
        delegationReference: "Delegation reference",
      },
      reasons: {
        absent: "No {label} was recorded at the owning boundary.",
        unknown: "The {label} was expected, but its evidence is unavailable or unreadable.",
        unsupported: "This execution path does not provide {label} evidence.",
        invokerAbsent: "The supported ingress boundary recorded no usable invoker principal.",
        noGrants: "No applicable grants were recorded for this run.",
        noAssurance: "No assurance evidence was recorded for this run.",
        noLineage: "No parent or subagent lineage was recorded for this run.",
      },
      identityHeading: "Identity and authority",
      missingEvidenceHeading: "Missing evidence",
      noMissingEvidence: "No missing evidence was reported for this projection.",
      nextStepsHeading: "Next steps",
      decisions: {
        heading: "Decision receipts",
        none: "No decision receipts were returned for this bounded page.",
        returned: "The Gateway returned {count} receipt summaries for this bounded page.",
        more: "Additional decision receipts are available. This inspector intentionally shows only the bounded first page; use the audit CLI with a cursor for later pages.",
        bounded: "Decision inspection is bounded to at most 50 records per request.",
      },
      diagnosticReason: "Diagnostic reason:",
      diagnostic: {
        notFound: {
          title: "Run not found",
          description:
            "No retained run or identity record matched this reference. Missing best-effort evidence does not prove that the run never occurred.",
        },
        expired: {
          title: "Identity evidence expired",
          description:
            "The Gateway found the run, but its identity context is outside the 30-day retention window.",
        },
        corrupt: {
          title: "Identity evidence is corrupt",
          description:
            "The Gateway found evidence for this run but could not validate the stored identity context.",
        },
        ambiguous: {
          title: "Multiple executions match this run",
          description:
            "A run reference can correlate more than one execution. The inspector will not guess which execution you meant.",
        },
        unsupported: {
          title: "Identity evidence unsupported",
          description:
            "The run is known, but this execution path did not retain a supported identity context.",
        },
        unknown: {
          title: "Identity evidence unknown",
          description:
            "The path promises evidence, but the expected record is missing, unreadable, or otherwise unavailable.",
        },
      },
      candidates: {
        listLabel: "Matching executions",
        recorded: "Recorded {date}",
        executionReference: "Inspect execution",
        more: "More matching executions exist beyond this bounded page.",
        loadMore: "Load more executions",
        loadingMore: "Loading executions…",
        loadMoreError: "More executions could not be loaded. Try again.",
      },
      panels: {
        empty: {
          title: "No run selected",
          description:
            "Open a link shaped like /activity?view=run&run=<run-id> to inspect durable identity evidence.",
        },
        waiting: {
          title: "Waiting for the Gateway",
          description: "The durable projection will load when this browser reconnects.",
        },
        loading: {
          title: "Loading run inspection",
          description: "Reading the Gateway's retained identity projection…",
        },
        disconnected: {
          title: "Gateway disconnected",
          description:
            "Run identity is durable on the Gateway, but it cannot be read while this browser is disconnected.",
        },
        unauthorized: {
          title: "Operator read access required",
          description:
            "This connection does not have operator.read, so retained run identity cannot be loaded.",
        },
        unsupported: {
          title: "Run inspection unsupported",
          description:
            "This Gateway does not offer audit.run.inspect. Upgrade the Gateway, enable execution identity collection, and record a new run.",
        },
        error: {
          title: "Run inspection failed",
          description:
            "The Gateway could not return this diagnostic projection. No identity facts were inferred from Live activity.",
        },
      },
      retry: "Retry inspection",
    },
  },
} satisfies TranslationMap;

export const registerActivityEnglish = Object.assign(
  () => {
    en.activity = enActivity.activity;
  },
  { catalog: enActivity },
);
