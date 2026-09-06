package ai.openclaw.app.node

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class NodeHostStatsReporterTest {
  private val sample =
    NodeHostStatsReporter.Sample(
      cpuCount = 8,
      memoryTotalBytes = 8_000_000_000,
      memoryFreeBytes = 3_000_000_000,
      diskTotalBytes = 128_000_000_000,
      diskAvailableBytes = 64_000_000_000,
    )

  @Test
  fun makePayloadJson_includesHostStatsWithoutLoadAverage() {
    assertPayload(
      sample,
      """{"cpuCount":8,"memoryTotalBytes":8000000000,"memoryFreeBytes":3000000000,"diskTotalBytes":128000000000,"diskAvailableBytes":64000000000}""",
    )
  }

  @Test
  fun makePayloadJson_omitsUnavailableDiskPair() {
    for (disk in listOf(null to null, null to 10L, 10L to null)) {
      assertPayload(
        sample.copy(diskTotalBytes = disk.first, diskAvailableBytes = disk.second),
        """{"cpuCount":8,"memoryTotalBytes":8000000000,"memoryFreeBytes":3000000000}""",
      )
    }
  }

  @Test
  fun makePayloadJson_clampsFreeBytesToTotal() {
    assertPayload(
      sample.copy(memoryFreeBytes = 9_000_000_000, diskAvailableBytes = 256_000_000_000),
      """{"cpuCount":8,"memoryTotalBytes":8000000000,"memoryFreeBytes":8000000000,"diskTotalBytes":128000000000,"diskAvailableBytes":128000000000}""",
    )
  }

  @Test
  fun makePayloadJson_enforcesNonNegativeBytesAndCpuBounds() {
    for ((cpuCount, expectedCpuCount) in listOf(0 to 1, 4097 to 4096)) {
      assertPayload(
        NodeHostStatsReporter.Sample(cpuCount, -1, -2, -3, -4),
        """{"cpuCount":$expectedCpuCount,"memoryTotalBytes":0,"memoryFreeBytes":0,"diskTotalBytes":0,"diskAvailableBytes":0}""",
      )
    }
  }

  private fun assertPayload(
    sample: NodeHostStatsReporter.Sample,
    expected: String,
  ) {
    assertEquals(
      Json.parseToJsonElement(expected).jsonObject,
      Json.parseToJsonElement(NodeHostStatsReporter.makePayloadJson(sample)).jsonObject,
    )
  }
}
