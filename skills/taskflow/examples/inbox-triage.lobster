# Illustrative Lobster authoring example for a TaskFlow-style inbox triage job.
# Swap the placeholder commands for your own tools or scripts.

name: inbox-triage
steps:
  - id: fetch
    command: gog.gmail.search --query 'newer_than:1d' --max 20

  - id: classify
    command: >-
      openclaw.invoke --tool llm-task --action json --args-json
      '{"prompt":"Classify each inbox item as business, personal, or later. Return one JSON object per item with route and summary.","thinking":"low","schema":{"type":"object","properties":{"items":{"type":"array"}},"required":["items"],"additionalProperties":false}}'
    stdin: $fetch.stdout

  - id: post_business
    command: slack-route --bucket business
    stdin: $classify.stdout
    condition: $classify.json.items[0].route == "business"

  - id: wait_for_business_reply
    command: echo '{"status":"waiting","reason":"slack_reply"}'
    condition: $classify.json.items[0].route == "business"

  - id: notify_personal
    command: >-
      openclaw.invoke --tool message --action send --args-json
      '{"provider":"telegram","to":"owner-thread","content":"Personal inbox item needs attention."}'
    condition: $classify.json.items[0].route == "personal"

  - id: stash_for_eod
    command: summary-append --bucket eod
    stdin: $classify.stdout
    condition: $classify.json.items[0].route == "later"
