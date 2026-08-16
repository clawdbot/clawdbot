# Exact-head real Gateway UI proof

This evidence was captured from PR head `74d6a3e7f91951ef1e184624059eb52cb4f5c102`.

- The literal built Control UI connected to an isolated real `GatewayServer` over WebSocket.
- The Gateway recorded a real `skills.status` request.
- The UI rendered `This agent inherits the default skill allowlist.` on the Agents → Skills page.
- The inspection snapshot records the exact route, title, inherited-default notice, and visible skill rows.

Artifacts:

- [Inherited-default screenshot](01-inherits-default-skill-allowlist.png)
- [Real-Gateway inspection screenshot](02-real-gateway-inspection.png)
- [Inspection JSON](inspect.json)

The capture intentionally makes no claim about the later virtualized-row filter interaction; this proof is limited to the inherited-default behavior and the real Gateway connection.
