const TLS_SECRET_FIELDS = ["ca", "cert", "key", "passphrase"] as const;

// Runtime collects direct TLS before proxy TLS; the public registry retains the opposite order.
export const PROVIDER_REQUEST_SECRET_FIELD_GROUPS = [
  { path: ["headers"], fields: "*", registryOrder: 0 },
  { path: ["auth"], fields: ["token", "value"], registryOrder: 1 },
  { path: ["tls"], fields: TLS_SECRET_FIELDS, registryOrder: 3 },
  { path: ["proxy", "tls"], fields: TLS_SECRET_FIELDS, registryOrder: 2 },
] as const;
