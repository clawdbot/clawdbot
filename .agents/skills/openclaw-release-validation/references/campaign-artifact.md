# Build the campaign artifact

Run only when `RELEASE_VALIDATION_ARTIFACT_PATH` is present. Skip the installed
skill update check and interactive preparation. GitHub is read-only; write only
the requested artifact.

In **Campaign artifact**, use the exact tag, release commit, and guidance-main
SHA supplied in `RELEASE_VALIDATION_TAG`,
`RELEASE_VALIDATION_RELEASE_COMMIT`, and
`RELEASE_VALIDATION_GUIDANCE_MAIN_SHA`. For a beta tag:

1. Resolve its stable train, release URL, commit, the previous stable release,
   and one immutable guidance SHA from the current `origin/main`. Record that
   exact SHA; both analysis windows end there.
2. Fetch `https://docs.openclaw.ai/maturity/scorecard.md`. Extract the live
   surface names, taxonomy links, M-levels, maturity labels, and score-band
   guidance. Stop if it cannot be parsed; never use a hardcoded catalog.
3. Read complete release notes and source history. Group all user-visible and
   upgrade-sensitive changes under live scorecard surfaces for two windows:
   previous stable through the guidance-main SHA, and the current beta commit
   through that same guidance-main SHA. The first window describes the release
   train overall; the second highlights what has landed on main since the
   current beta was cut. Use PR and commit details for analysis, but publish
   themes rather than a misleading sample of links.
4. Rank exactly three surfaces for each window using change volume, size,
   complexity, impact, upgrade sensitivity, and maturity expectations. A
   Stable or Clawesome surface carries more regression weight. Duplicate
   surfaces across the two lists are allowed. Do not publish numeric scores.
5. Render each selected surface as:

   ```md
   ### [surface](taxonomy-url)

   | **Maturity score**      | <M-level and label>                                          |
   | ----------------------- | ------------------------------------------------------------ |
   | **What changed**        | <dominant themes>                                            |
   | **Recommended testing** | <action and pass condition, with command or URL when useful> |
   | **Testing notes**       |                                                              |
   ```

   Keep **Testing notes** empty. Escape table pipes. Recommended testing must
   be one bounded, human-driven action with an observable pass condition. Use
   `{{OPENCLAW}}` wherever the tester should invoke the selected gateway and
   `{{RESTART_GATEWAY}}` for its restart command. Do not assume OCM, add other
   execution placeholders, or say only "use" or "verify."

6. Replace the issue title with `OpenClaw <YYYY.M.D> beta feedback`. Render the
   body in this order, with no beta-history section:

   ```md
   <!-- openclaw-release-validation:<stable-train> -->

   - Current beta: [<beta-tag>](release-url)
   - Beta commit: `<full-commit>`
   - Guidance main commit: `<full-guidance-main-sha>`
   - Test target: latest immutable `origin/main`

   > [!NOTE]
   > <live scorecard and maturity-band explanation; any surface may be tested>

   <!-- validation-guidance:start -->

   ## Priority surfaces for this release

   <exactly three surface tables>

   ## Priority surfaces since <current-beta>

   <exactly three surface tables>
   <!-- validation-guidance:end -->

   ## Participate

   <concise instruction to run this skill>
   ```

7. Write this exact JSON shape to `RELEASE_VALIDATION_ARTIFACT_PATH`:

   ```json
   {
     "schema": "openclaw.release-validation-campaign/v1",
     "operation": "upsert",
     "tag": "<exact beta tag>",
     "stableTrain": "<vYYYY.M.D>",
     "releaseUrl": "https://github.com/openclaw/openclaw/releases/tag/<tag>",
     "releaseCommit": "<exact supplied release commit>",
     "guidanceMainSha": "<exact supplied guidance SHA>",
     "title": "OpenClaw <YYYY.M.D> beta feedback",
     "body": "<rendered body>"
   }
   ```

   Write valid JSON, not a Markdown fence. Create no other files and do not
   call a GitHub mutation API.

For a stable tag, skip analysis and write this exact JSON shape to
`RELEASE_VALIDATION_ARTIFACT_PATH`:

```json
{
  "schema": "openclaw.release-validation-campaign/v1",
  "operation": "close",
  "tag": "<exact stable tag>",
  "stableTrain": "<same exact stable tag>",
  "releaseUrl": "https://github.com/openclaw/openclaw/releases/tag/<tag>"
}
```

The trusted publisher validates every field, creates the two release-validation
labels when needed, updates or creates the campaign, preserves comments, and
closes older campaigns. Campaign publishing is deliberately last-writer-simple;
release orchestration does not launch overlapping update tasks.
