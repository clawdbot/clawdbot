---
summary: "Build and deploy the Red Hat and OpenShift FIPS profile"
read_when:
  - You deploy OpenClaw on RHEL or OpenShift
  - Your system boundary requires FIPS-validated cryptography
  - You are preparing OpenClaw for a government authorization package
title: "Red Hat and FIPS"
---

# Red Hat and FIPS

OpenClaw provides a separate Red Hat runtime target and an OpenShift Kustomize
overlay. They are deployment building blocks, not a FedRAMP authorization or a
claim that every OpenClaw feature uses FIPS-validated cryptography.

## What this profile proves

The profile can collect evidence that:

- the runtime uses the digest-pinned UBI 9 Node.js image;
- Node uses the Red Hat system OpenSSL;
- the host kernel and Node report FIPS mode;
- required Node cryptographic primitives, TLS 1.3, and `node:sqlite` work;
- the container runs without a fixed UID under OpenShift `restricted-v2`.

The profile does not validate browser JavaScript, plugin, WASM, native-addon, or
child-process cryptography. Keep an approved feature and plugin inventory for
your deployment.

## Platform prerequisite

Install or boot the RHEL or OpenShift nodes in FIPS mode before generating
production keys. Applying the `FIPS` cryptographic policy after deployment is
not equivalent to starting with a FIPS installation.

The supported production path is the UBI 9 container target below. Do not use
the generic host installer as the government cryptographic boundary. The
Node.js 24 AppStream in RHEL 9.7 and 9.8 is a Technology Preview, and RHEL 10
uses a different package and binary contract. Direct host installation remains
an evaluation-only gap until Red Hat provides a GA-supported package path that
can be tested and verified end to end.

## Build the Red Hat runtime

The UBI base is pinned by digest in `Dockerfile`.

```bash
docker build --target rhel-runtime -t openclaw-rhel:local .
```

The default Docker target remains the general Debian image. The Red Hat target
reuses portable OpenClaw JavaScript build assets, but installs and prunes the
production dependency tree in a UBI 9 build stage. Native dependency install
scripts therefore run against the RHEL 9 ABI before the final Red Hat Node.js
and system OpenSSL runtime is assembled. The image copies `catatonit` from the
Red Hat `podman` RPM in a disposable UBI stage, then uses it as PID 1 to forward
signals and reap child processes. It does not participate in the cryptographic
boundary.

Before promotion, build the target on the same RHEL major version and
architecture used in production and exercise every approved native plugin.
Native dependencies remain part of the compatibility and cryptographic
boundary.

## Run the FIPS preflight

Inside the image:

```bash
docker run --rm openclaw-rhel:local \
  node /app/scripts/compliance/rhel-fips-check.mjs --json
```

The command exits nonzero when a required runtime check fails. A normal UBI
container on a non-FIPS host must fail the kernel and Node FIPS checks. Final
evidence must come from the production RHEL/OpenShift FIPS environment.

Containers do not always expose `/proc/sys/crypto/fips_enabled`. When it is
unavailable, the kernel check is reported as `skip`; the required Node FIPS
check must still pass, and the authorization evidence must retain host or
cluster installation proof.

The report is runtime evidence only. It is not a CMVP certificate, FIPS
validation, or FedRAMP authorization.

## Deploy on OpenShift

Build and push the Red Hat target to an approved registry, then set its immutable
digest in the overlay:

```yaml
images:
  - name: ghcr.io/openclaw/openclaw
    newName: registry.example.gov/openclaw
    digest: sha256:<approved-image-digest>
```

Preview and apply:

```bash
kubectl kustomize scripts/k8s/overlays/openshift-government
kubectl apply -k scripts/k8s/overlays/openshift-government
```

The overlay removes fixed UID/GID requests, uses the UBI home directory, keeps a
read-only root filesystem, drops Linux capabilities, disables privilege
escalation, uses `RuntimeDefault` seccomp, and disables automatic service
account token mounting.

The included NetworkPolicy fails closed. It allows DNS, explicitly labeled
Gateway clients, and explicitly labeled in-cluster egress proxies. Adapt the
ports and selectors to your platform. Kubernetes NetworkPolicy cannot express
provider DNS allowlists reliably; enforce external destinations at the egress
proxy, OpenShift EgressFirewall, service mesh, or cloud network boundary.

## TLS and PKI

Terminate external TLS at an approved OpenShift ingress, service mesh, or
agency load balancer. Use the platform's validated cryptographic module and
agency-issued certificates.

If the Gateway terminates TLS itself:

```json5
{
  gateway: {
    tls: {
      enabled: true,
      autoGenerate: false,
      certPath: "/etc/openclaw/tls/tls.crt",
      keyPath: "/etc/openclaw/tls/tls.key",
      caPath: "/etc/openclaw/tls/ca-bundle.crt",
    },
  },
}
```

Do not use the self-signed auto-generation path for production. `caPath` adds a
trust bundle; it does not by itself configure mutual TLS client
authentication.

## Secrets and workload identity

Use [SecretRefs](/gateway/secrets) instead of plaintext credentials. For Vault
on OpenShift, prefer Kubernetes or projected-JWT authentication with a scoped
role. Avoid long-lived Vault tokens in Kubernetes Secrets.

Before promotion:

```bash
openclaw secrets audit --check --allow-exec
```

Remove plaintext residue from `openclaw.json`, environment files, generated
model files, backups, and the SQLite auth-profile store.

## Plugins and feature approval

Preinstall the approved plugin set in the image. Do not allow ad hoc plugin,
skill, or package installation in the runtime namespace. Enforce
`security.installPolicy` and delivery-pipeline allowlists for any remaining
installation surface.

Maintain a crypto inventory for:

- core device identity and Control UI device keys;
- Matrix native/WASM crypto;
- WhatsApp, Nostr, Reef, and other protocol-specific crypto;
- browser JavaScript cryptography;
- native addons and child processes.

Red Hat system FIPS mode does not move those implementations into the system
OpenSSL validation boundary.

## Audit, egress, and supply chain

The built-in audit ledger is bounded and best-effort. Export security and
operational events to an external OpenTelemetry/SIEM path with deployment-owned
retention, integrity, access control, and alerting.

The Node managed proxy is not an OS network sandbox. Enforce egress with
NetworkPolicy, an egress proxy/firewall, DNS controls, and cloud networking.

Retain and verify:

- an SPDX SBOM;
- SLSA provenance;
- image signatures and immutable digests;
- vulnerability and malware scan results;
- the approved base image digest;
- offline mirror/import records where the environment is disconnected.

## PQC boundary

Treat post-quantum cryptography as a platform migration first. Prefer approved
PQC or hybrid support at ingress, service mesh, VPN, SSH, and artifact-signing
boundaries. Do not add experimental PQC libraries to the Node process without
an approved module, protocol plan, compatibility analysis, and agency
acceptance.

## Release gate

Do not describe the profile as ready until all of these are proven on the
production-equivalent environment:

1. the image runs under OpenShift `restricted-v2` with arbitrary UIDs;
2. the FIPS preflight passes on real FIPS-enabled nodes;
3. Gateway startup, TLS, SQLite, Vault SecretRefs, telemetry, and the approved
   plugin set pass;
4. SBOM, provenance, signature, scan, and mirror evidence is retained;
5. every enabled cryptographic implementation has an owner and boundary
   disposition.

## Related

- [Kubernetes](/install/kubernetes)
- [Docker](/install/docker)
- [Secrets management](/gateway/secrets)
- [Vault SecretRefs](/plugins/vault)
- [Security](/gateway/security)
- [OpenTelemetry](/gateway/opentelemetry)
