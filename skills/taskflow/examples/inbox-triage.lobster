# Runnable synthetic preview. Requires Node; no mailbox or messaging adapters.
# Approval pauses this workflow, not a listener for an arbitrary Slack reply.
name: inbox-triage
args:
  items:
    default:
      - { id: demo-business-1, route: business }
      - { id: demo-personal-1, route: personal }
      - { id: demo-later-1, route: later }
      - { id: demo-business-2, route: business }
steps:
  - id: review
    command: >-
      node -e '
      const { items } = JSON.parse(process.env.LOBSTER_ARGS_JSON);
      if (!Array.isArray(items) || items.length > 20) throw new Error("Expected at most 20 synthetic items");
      const routes = { business: [], personal: [], later: [] };
      for (const item of items) {
        if (!item || typeof item.id !== "string" || !item.id.trim() || item.id.length > 80 ||
            typeof item.route !== "string" || !Object.hasOwn(routes, item.route)) {
          throw new Error("Each item needs an id and a business, personal or later route");
        }
        routes[item.route].push(item.id);
      }
      process.stdout.write(JSON.stringify({ synthetic: true, routes }));'
    approval:
      prompt: "Approve this synthetic inbox routing? No messages will be sent."

  - id: result
    command: node -e 'process.stdout.write(require("node:fs").readFileSync(0))'
    stdin: $review.stdout
    condition: $review.approved
