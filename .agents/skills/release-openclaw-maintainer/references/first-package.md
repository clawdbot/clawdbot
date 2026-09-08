# First-package registry preparation

Use before tagging when the release introduces a newly publishable npm or
ClawHub package.

- Before tagging, diff publishable plugin package manifests against the last
  reachable stable/beta release tag. For every newly publishable package
  (`openclaw.release.publishToNpm: true` or `publishToClawHub: true`) whose
  package name did not exist in the base tag, verify the target registry package
  already exists in npm/ClawHub or stop and help the owner mint/prepublish the
  package first. Do not hide or disable release surfaces just to unblock a
  train unless the owner explicitly decides the plugin should not ship in that
  release; first-package registry ownership is release prep, not product
  rollback. The mint/prepublish path must either be the real release publish
  path for the auto-bumped beta version, or a deliberately non-consuming
  registry-prep step that cannot occupy the next beta version/tag. Confirm
  registry owner, npm scope/package-creation permission, provenance path, and
  first-package publish plan before the full release publish continues. Useful
  npm probe:
  `npm view <package-name> version dist-tags --json --prefer-online`; a 404 for
  a package newly added to the release is a release-prep blocker, not something
  to discover from the publish job.
- Bootstrap a new ClawHub package only from the trusted workflow source:
  `gh workflow run plugin-clawhub-new.yml --ref main -f plugins=@openclaw/name -f ref=<full-release-sha> -f pretag_validation=true -f dry_run=true`.
  The workflow source stays on `main`; `ref` is the exact release target. A
  pre-tag dry run rejects tag/parent-approval inputs and requires the target to be
  reachable from `main` or `release/*`. It must still resolve the live registry
  plan, pack every candidate, upload and download the exact artifact ID, rehash
  the inventory, reject ambiguous TAR paths locally with the pinned CLI's USTAR
  canonicalization, and validate each tarball with the pinned CLI publish
  dry-run. It never loads credentials or changes package/trusted-publisher
  state. Approve the `clawhub-plugin-bootstrap` environment only after the
  secretless pack jobs finish; the protected validation job itself has no
  credentials or mutation commands. For an
  existing version missing trusted-publisher configuration, pack the target
  bytes too and require its tag plus exact registry byte/metadata equality
  before allowing configuration-only repair. The credential-job prefilter
  enforces the ClawHub 120 MiB compressed and 50 MiB total-payload limits, plus
  64 MiB expanded-TAR and 10,000-TAR-entry parser-safety limits. A mismatch
  requires a new version; never bless unrelated immutable bytes. A real run
  publishes the exact downloaded tarball, bounds each CLI attempt, and records
  byte-identical registry readback. Final release verification must consume the
  unique terminal readback artifact and bind its main-only workflow SHA/attempt,
  target SHA, requested packages, package artifact ID/name/digest, and
  per-package SHA-256/size/npm integrity metadata. The parent approval attests a
  separate exact trusted-main child workflow SHA; the child run and protected
  approval must match it. Rerun-failed recovery may reuse a prior package
  artifact only when the exact producer job succeeded. Final evidence must also
  preserve the locked ClawHub version, lock SHA-256, and npm integrity.
