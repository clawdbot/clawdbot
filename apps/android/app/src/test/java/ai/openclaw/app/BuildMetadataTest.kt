package ai.openclaw.app

import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class BuildMetadataTest {
  @Test
  fun debugBuildConfigContainsRepositoryCommitAndUtcBuildTimestamp() {
    assertTrue(Regex("^[a-f0-9]{40}$").matches(BuildConfig.GIT_COMMIT))
    assertTrue(
      Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$")
        .matches(BuildConfig.BUILD_TIMESTAMP),
    )
    Instant.parse(BuildConfig.BUILD_TIMESTAMP)
  }
}
