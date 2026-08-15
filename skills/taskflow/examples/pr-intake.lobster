# Illustrative Lobster authoring example for a TaskFlow-style PR intake lane.
# Replace the placeholder commands with repo-specific tooling.

name: pr-intake
steps:
  - id: fetch
    command: gh pr list --repo owner/repo --state open --json number,title,body,headRefName

  - id: classify
    command: >-
      openclaw.invoke --tool llm-task --action json --args-json
      '{"prompt":"Classify each PR as close, request_changes, refactor, or maintainer_review. Return intent and recommended next action.","thinking":"low","schema":{"type":"object","properties":{"items":{"type":"array"}},"required":["items"],"additionalProperties":false}}'
    stdin: $fetch.stdout

  - id: close_low_signal
    command: pr-close-low-signal
    stdin: $classify.stdout
    condition: $classify.json.items[0].nextAction == "close"

  - id: request_changes
    command: pr-request-changes
    stdin: $classify.stdout
    condition: $classify.json.items[0].nextAction == "request_changes"

  - id: refactor_branch
    command: pr-refactor-branch
    stdin: $classify.stdout
    condition: $classify.json.items[0].nextAction == "refactor"

  - id: escalate
    command: echo '{"status":"notify","target":"maintainer"}'
    condition: $classify.json.items[0].nextAction == "maintainer_review"
