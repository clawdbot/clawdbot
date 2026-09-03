package ai.openclaw.app.node

import android.app.ActivityManager
import android.content.Context
import android.os.Environment
import android.os.StatFs
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

internal object NodeHostStatsReporter {
  const val EVENT_NAME: String = "node.host.stats"
  const val INTERVAL_MS: Long = 60_000

  data class Sample(
    val cpuCount: Int,
    val memoryTotalBytes: Long,
    val memoryFreeBytes: Long,
    val diskTotalBytes: Long? = null,
    val diskAvailableBytes: Long? = null,
  )

  fun sample(context: Context): Sample {
    val memory = ActivityManager.MemoryInfo()
    checkNotNull(context.getSystemService(ActivityManager::class.java)).getMemoryInfo(memory)
    val disk =
      runCatching {
        val stats = StatFs(Environment.getDataDirectory().path)
        stats.totalBytes to stats.availableBytes
      }.getOrNull()
    return Sample(
      cpuCount = Runtime.getRuntime().availableProcessors(),
      memoryTotalBytes = memory.totalMem,
      memoryFreeBytes = memory.availMem,
      diskTotalBytes = disk?.first,
      diskAvailableBytes = disk?.second,
    )
  }

  fun makePayloadJson(sample: Sample): String =
    buildJsonObject {
      val memoryTotal = sample.memoryTotalBytes.coerceAtLeast(0L)
      put("cpuCount", JsonPrimitive(sample.cpuCount.coerceIn(1, 4096)))
      put("memoryTotalBytes", JsonPrimitive(memoryTotal))
      put("memoryFreeBytes", JsonPrimitive(sample.memoryFreeBytes.coerceIn(0L, memoryTotal)))
      // Disk fields are a pair in the Gateway contract; failed sampling omits both.
      if (sample.diskTotalBytes != null && sample.diskAvailableBytes != null) {
        val diskTotal = sample.diskTotalBytes.coerceAtLeast(0L)
        put("diskTotalBytes", JsonPrimitive(diskTotal))
        put("diskAvailableBytes", JsonPrimitive(sample.diskAvailableBytes.coerceIn(0L, diskTotal)))
      }
    }.toString()
}
