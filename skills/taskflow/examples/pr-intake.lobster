# Runnable synthetic preview. Requires Node; no GitHub reads or mutations.
name: pr-intake
args:
  items:
    default:
      - { id: demo-pr-1, intent: close }
      - { id: demo-pr-2, intent: request_changes }
      - { id: demo-pr-3, intent: refactor }
      - { id: demo-pr-4, intent: maintainer_review }
      - { id: demo-pr-5, intent: refactor }
steps:
  - id: review
    command: >-
      node -e '
      const { items } = JSON.parse(process.env.LOBSTER_ARGS_JSON);
      if (!Array.isArray(items) || items.length > 20) throw new Error("Expected at most 20 synthetic items");
      const routes = { close: [], request_changes: [], refactor: [], maintainer_review: [] };
      for (const item of items) {
        if (!item || typeof item.id !== "string" || !item.id.trim() || item.id.length > 80 ||
            typeof item.intent !== "string" || !Object.hasOwn(routes, item.intent)) {
          throw new Error("Each item needs an id and a close, request_changes, refactor or maintainer_review intent");
        }
        routes[item.intent].push(item.id);
      }
      process.stdout.write(JSON.stringify({ synthetic: true, routes }));'
    approval:
      prompt: "Approve this synthetic PR routing? No GitHub actions will be performed."

  - id: result
    command: node -e 'process.stdout.write(require("node:fs").readFileSync(0))'
    stdin: $review.stdout
    condition: $review.approved
