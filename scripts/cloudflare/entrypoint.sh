#!/bin/sh
set -eu

STATE_ROOT=/home/node/.openclaw
CONFIG=/etc/litestream.yml

mkdir -p "$STATE_ROOT/state" "$STATE_ROOT/agents"

log() {
  printf '[cloudflare-entrypoint] %s\n' "$*"
}

replica_url_for_db() {
  db_path=$1
  resolved_path=$(realpath -m "$db_path")
  case "$resolved_path" in
    "$STATE_ROOT"/state/*.sqlite)
      relative_path=${resolved_path#"$STATE_ROOT/state/"}
      replica_path="replicas/state/$relative_path"
      ;;
    # case globs match "/" (fnmatch without FNM_PATHNAME), so this accepts the
    # nested canonical layout agents/<id>/agent/openclaw-agent.sqlite.
    "$STATE_ROOT"/agents/*.sqlite)
      relative_path=${resolved_path#"$STATE_ROOT/agents/"}
      replica_path="replicas/agents/$relative_path"
      ;;
    *)
      log "refusing restore path outside configured directory roots: $db_path"
      return 1
      ;;
  esac

  printf 's3://%s/%s?endpoint=%s&region=%s&forcePathStyle=true\n' \
    "$LITESTREAM_BUCKET" "$replica_path" "$LITESTREAM_ENDPOINT" "$LITESTREAM_REGION"
}

list_replica_databases() {
  node --input-type=module <<'NODE'
import { createHash, createHmac } from "node:crypto";

const {
  LITESTREAM_ACCESS_KEY_ID: accessKeyId,
  LITESTREAM_BUCKET: bucket,
  LITESTREAM_ENDPOINT: endpoint,
  LITESTREAM_REGION: region,
  LITESTREAM_SECRET_ACCESS_KEY: secretAccessKey,
} = process.env;

for (const [name, value] of Object.entries({
  LITESTREAM_ACCESS_KEY_ID: accessKeyId,
  LITESTREAM_BUCKET: bucket,
  LITESTREAM_ENDPOINT: endpoint,
  LITESTREAM_REGION: region,
  LITESTREAM_SECRET_ACCESS_KEY: secretAccessKey,
})) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
const encode = (value) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

function decodeXml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

async function listPage(continuationToken) {
  const query = [
    ["encoding-type", "url"],
    ["list-type", "2"],
    ["prefix", "replicas/"],
  ];
  if (continuationToken) {
    query.push(["continuation-token", continuationToken]);
  }
  query.sort(([left], [right]) => left.localeCompare(right));
  const canonicalQuery = query.map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");

  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${encode(bucket)}`;
  url.search = canonicalQuery;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256("");
  const canonicalHeaders =
    `host:${url.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "GET",
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const dateKey = hmac(`AWS4${secretAccessKey}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const response = await fetch(url, {
    headers: {
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},` +
        `SignedHeaders=${signedHeaders},Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
  });
  if (!response.ok) {
    throw new Error(`R2 ListObjectsV2 failed with HTTP ${response.status}`);
  }

  const xml = await response.text();
  const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) =>
    decodeURIComponent(decodeXml(match[1])),
  );
  const tokenMatch = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
  return {
    keys,
    nextToken: tokenMatch ? decodeXml(tokenMatch[1]) : undefined,
  };
}

function localDatabasePath(key) {
  const match = /^replicas\/(state|agents)\/(.+\.sqlite)\/\d{4}\/[^/]+\.ltx$/.exec(key);
  if (!match) {
    return undefined;
  }

  const [, root, relativePath] = match;
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /\s/.test(segment))) {
    throw new Error(`unsafe replica database path in R2 listing: ${key}`);
  }
  return `/home/node/.openclaw/${root}/${segments.join("/")}`;
}

const databasePaths = new Set();
let continuationToken;
do {
  const page = await listPage(continuationToken);
  for (const key of page.keys) {
    const databasePath = localDatabasePath(key);
    if (databasePath) {
      databasePaths.add(databasePath);
    }
  }
  continuationToken = page.nextToken;
} while (continuationToken);

for (const databasePath of [...databasePaths].sort()) {
  console.log(databasePath);
}
NODE
}

# Directory replication appends each database's relative path to the replica
# prefix. Restore therefore uses an R2 ListObjectsV2 result as its manifest.
if ! find "$STATE_ROOT/state" "$STATE_ROOT/agents" -type f -name '*.sqlite' -print -quit | grep -q .; then
  export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-$LITESTREAM_ACCESS_KEY_ID}"
  export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-$LITESTREAM_SECRET_ACCESS_KEY}"
  export AWS_REGION="${AWS_REGION:-$LITESTREAM_REGION}"

  restore_databases=$(list_replica_databases)
  for db_path in $restore_databases; do
    replica_url=$(replica_url_for_db "$db_path")
    mkdir -p "$(dirname "$db_path")"
    log "restoring database: $db_path"
    litestream restore -if-replica-exists -integrity-check quick -o "$db_path" "$replica_url"
  done
else
  log "sqlite state already present; restore skipped"
fi

log "starting Litestream replication with OpenClaw gateway child"
exec litestream replicate -config "$CONFIG" \
  -exec "node openclaw.mjs gateway --allow-unconfigured --bind lan --port 8080 --auth token"
