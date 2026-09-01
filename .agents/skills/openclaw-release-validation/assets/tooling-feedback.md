# OpenClaw release-validation tooling feedback

> Private, redacted, optional-report packet. This is not candidate feedback and
> must never be posted automatically or included in the release campaign.

## Run context

- Release train: {{RELEASE_TRAIN}}
- Tested main commit: {{MAIN_COMMIT_OR_NOT_REACHED}}
- Candidate result: {{CANDIDATE_RESULT_OR_NOT_EVALUATED}}
- Platform: {{OS_AND_ARCHITECTURE}}
- Tool versions: {{RELEVANT_TOOL_VERSIONS}}

## Tooling findings

Repeat the following block for each distinct tooling failure.

### {{SHORT_FAILURE_TITLE}}

- Tooling project: {{LIKELY_REPORT_TARGET}}
- Stage: {{FAILURE_STAGE}}
- Sanitized reproduction: `{{COMMAND_WITH_PLACEHOLDERS}}`
- Expected: {{EXPECTED_BEHAVIOR}}
- Observed: {{SANITIZED_OBSERVED_BEHAVIOR}}
- Impact: {{IMPACT_ON_VALIDATION}}
- Recovery state: {{RECOVERY_STATE}}

## Reporting choice

Nothing in this file has been posted. Review it before optionally reporting the
tooling issue to the project named above.
