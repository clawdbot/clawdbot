package bot.molt.android.voice

import android.media.MediaDataSource
import kotlin.math.min

internal class StreamingMediaDataSource : MediaDataSource() {
  private data class Chunk(val start: Long, val data: ByteArray)

  private val lock = Object()
  private val chunks = ArrayList<Chunk>()
  private var totalSize: Long = 0
  private var closed = false
  private var finished = false
  private var lastReadIndex = 0

  fun append(data: ByteArray) {
    if (data.isEmpty()) return
    synchronized(lock) {
      if (closed || finished) return
      val chunk = Chunk(totalSize, data)
      chunks.add(chunk)
      totalSize += data.size.toLong()
      lock.notifyAll()
    }
  }

  fun finish() {
    synchronized(lock) {
      if (closed) return
      finished = true
      lock.notifyAll()
    }
  }

  fun fail() {
    synchronized(lock) {
      closed = true
      lock.notifyAll()
    }
  }

  override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
    if (position < 0) return -1
    synchronized(lock) {
      while (!closed && !finished && position >= totalSize) {
        lock.wait()
      }
      if (closed) return -1
      if (position >= totalSize && finished) return -1

      val available = (totalSize - position).toInt()
      val toRead = min(size, available)
      var remaining = toRead
      var destOffset = offset
      var pos = position

      var index = findChunkIndex(pos)
      while (remaining > 0 && index < chunks.size) {
        val chunk = chunks[index]
        val inChunkOffset = (pos - chunk.start).toInt()
        if (inChunkOffset >= chunk.data.size) {
          index++
          continue
        }
        val copyLen = min(remaining, chunk.data.size - inChunkOffset)
        System.arraycopy(chunk.data, inChunkOffset, buffer, destOffset, copyLen)
        remaining -= copyLen
        destOffset += copyLen
        pos += copyLen
        if (inChunkOffset + copyLen >= chunk.data.size) {
          index++
        }
      }

      return toRead - remaining
    }
  }

  override fun getSize(): Long = -1

  override fun close() {
    synchronized(lock) {
      closed = true
      lock.notifyAll()
    }
  }

  private fun findChunkIndex(position: Long): Int {
    var index = lastReadIndex
    while (index < chunks.size) {
      val chunk = chunks[index]
      if (position < chunk.start + chunk.data.size) break
      index++
    }
    lastReadIndex = index
    return index
  }
}
