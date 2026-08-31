---
summary: "How ClawHub publishing works for skills, plugins, owners, scopes, releases, and review."
read_when:
  - Publishing a skill or plugin
  - Debugging owner or package scope errors
  - Adding publish UI, CLI, or backend behavior
---

# Publishing on ClawHub

ClawHub publishing is owner-scoped: every publish targets a publisher, and the
server decides whether the signed-in user can publish there.

## Owners

An owner is a ClawHub publisher handle, such as `@alice` or `@openclaw`.
Every user gets a personal owner; org owners can have multiple members with
`owner`, `admin`, or `publisher` roles.

When you publish, you use your personal owner or an org owner where you have
publisher access.

## Skills

Skills publish from a skill folder (`clawhub skill publish <path>`). The
public page is:

```text
https://clawhub.ai/<owner>/<slug>
```

Example:

```text
https://clawhub.ai/alice/review-helper
```

The publish request includes the selected owner, slug, version, changelog, and
files. The server verifies the actor can publish as that owner before creating
the release.

## Plugins

Plugins use npm-style package names (`clawhub package publish <source>`).
Scoped names include the owner in the first path segment:

```text
@owner/package-name
```

The scope must match the selected publish owner. A package named
`@openclaw/dronzer` can only be published as `@openclaw`. To publish as
`@vintageayu`, rename the package to `@vintageayu/dronzer`.

This stops a package from claiming an org namespace the publisher does not
control.

## Release flow

1. The UI, CLI, or GitHub workflow gathers package metadata and files.
2. The publish request goes to ClawHub with the selected owner.
3. The server validates owner permissions, package scope, package name,
   version, file limits, and source metadata. Validation failure means no
   release is created.
4. ClawHub stores the release and starts automated security checks.
5. The release stays hidden from normal install/download surfaces until
   review and verification finish.

## FAQ

### Package scope must match selected owner

If the package scope and selected owner do not match, ClawHub rejects the
publish:

```text
Package scope "@openclaw" must match selected owner "@vintageayu".
Publish as "@openclaw" or rename this package to "@vintageayu/dronzer".
```

Fix it by either publishing as the owner named in the scope, or renaming the
package so its scope matches the owner you can publish as.

If the package already has the right scope but the wrong publisher owns it,
transfer it instead:

```sh
clawhub package transfer @opik/opik-openclaw --to opik
```

Package transfer needs admin access to both the current owner and the
destination publisher; it does not let you publish into a scope you do not
control. This is the same namespace protection: a package named
`@openclaw/dronzer` claims the `@openclaw` namespace, so only publishers with
access to `@openclaw` can publish or transfer into it.
