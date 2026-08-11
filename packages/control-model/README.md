# `@openclaw/control-model`

Framework-neutral state and command projections above
`@openclaw/gateway-client`.

The first workspace-only slice owns connection lifecycle and immutable session
catalog snapshots. It does not include conversation messages, UI artifacts,
framework adapters, or npm publication.

## Bind a Gateway client

Hosts adapt their existing Gateway connection to `ControlModelGatewayBinding`:

```ts
import { createControlModel } from "@openclaw/control-model";

const model = createControlModel({
  gateway: {
    getConnectionSnapshot: () => connectionSnapshot,
    subscribeConnection: (listener) => connectionStore.subscribe(listener),
    subscribeEvents: (listener) => gatewayEvents.subscribe(listener),
    request: (method, params, options) => gateway.request(method, params, options),
  },
});

model.start();
const unsubscribe = model.subscribe(() => {
  render(model.getSnapshot());
});
```

The binding supplies monotonically increasing connection epochs. A response
captured under a retired epoch never replaces state from the current
connection.

## Session snapshots

`model.refreshSessions()` requests one bounded `sessions.list` result and
publishes a deeply frozen snapshot. Live `sessions.changed` events schedule a
canonical refresh; they do not mutate rows directly.

Subscriber notifications run in a coalesced microtask. A slow or throwing
subscriber cannot block the Gateway event callback or prevent other subscribers
from observing the current snapshot.

Call `model.dispose()` before releasing the host connection.
