import type { GatewayHelloOk } from "../api/gateway.ts";

export function gatewayHelloForMethods(
  methods: readonly string[],
  scopes: readonly string[] = ["operator.admin"],
): GatewayHelloOk {
  return {
    type: "hello-ok",
    protocol: 4,
    features: { methods: [...methods] },
    auth: { role: "operator", scopes: [...scopes] },
  };
}
