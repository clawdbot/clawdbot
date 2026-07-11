package ai.openclaw.app.chat

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.withTransaction
import java.util.UUID

/** Upper bound of durable outbox rows per gateway; enqueue is refused beyond this. */
internal const val OUTBOX_MAX_QUEUED = 50

/** Queued commands older than this are expired instead of sending stale instructions. */
internal const val OUTBOX_EXPIRY_MS = 48L * 60L * 60L * 1000L

/** lastError marker for items expired by [OUTBOX_EXPIRY_MS]; also shown in the UI row. */
internal const val OUTBOX_EXPIRED_ERROR = "expired"

/** Delivery is ambiguous after dispatch without an acknowledgement; retry needs explicit intent. */
internal const val OUTBOX_DELIVERY_UNCONFIRMED_ERROR = "delivery unconfirmed; retry manually"

/** Connection-gated command rows never auto-replay across a reconnect; retry needs explicit intent. */
internal const val OUTBOX_CONNECTION_CHANGED_ERROR = "connection changed before this command was sent; retry manually"

/**
 * gatedEpoch sentinel for rows migrated from schemas without epochs: it matches no live
 * connection generation, so legacy command-shaped rows park instead of auto-replaying.
 */
internal const val OUTBOX_GATED_EPOCH_NEVER = -1L

/** Chunk size for attachment BLOBs; each chunk row must stay well under Android's CursorWindow cap. */
internal const val OUTBOX_ATTACHMENT_CHUNK_BYTES = 512 * 1024

/** Upper bound of attachment bytes on one queued command (8 images plus a voice note fit). */
internal const val OUTBOX_MAX_COMMAND_ATTACHMENT_BYTES = 8L * 1024L * 1024L

/** Upper bound of queued attachment bytes per gateway so the outbox database stays bounded. */
internal const val OUTBOX_MAX_GATEWAY_ATTACHMENT_BYTES = 48L * 1024L * 1024L

enum class ChatOutboxStatus(
  internal val dbValue: String,
) {
  Queued("queued"),
  Sending("sending"),

  /**
   * The gateway acknowledged the send, but only canonical chat.history proves the user turn was
   * durably persisted (the started ACK is emitted before the transcript write). Accepted rows are
   * retired exclusively by history confirmation, or parked as failed when confirmation never lands.
   */
  Accepted("accepted"),
  Failed("failed"),
  ;

  internal companion object {
    // Schema bumps migrate explicitly, so unknown values should not occur; park anything
    // unexpected as Failed so it stays visible instead of silently sending.
    fun fromDb(value: String): ChatOutboxStatus = entries.firstOrNull { it.dbValue == value } ?: Failed
  }
}

/** Metadata for one durable attachment; bytes live in chunked BLOB rows keyed by [id]. */
data class ChatOutboxAttachment(
  val id: String,
  val type: String,
  val mimeType: String,
  val fileName: String,
  val durationMs: Long?,
  val byteLength: Long,
)

/** One durable queued chat command; [id] doubles as the chat.send idempotency key. */
data class ChatOutboxItem(
  val id: String,
  val sessionKey: String,
  val text: String,
  // Normalized thinking level captured at enqueue time, so a later selector change cannot
  // silently alter how an already-queued command is delivered.
  val thinkingLevel: String,
  val createdAtMs: Long,
  val status: ChatOutboxStatus,
  val retryCount: Int,
  val lastError: String?,
  // Non-null marks a connection-gated row (slash command): it may only auto-send while this
  // connection epoch is still active, so reconnects never silently replay a command.
  val gatedEpoch: Long? = null,
  val attachments: List<ChatOutboxAttachment> = emptyList(),
)

/** Attachment bytes captured at enqueue time; stored as binary chunks, never base64 at rest. */
class OutboxAttachmentPayload(
  val type: String,
  val mimeType: String,
  val fileName: String,
  val durationMs: Long?,
  val bytes: ByteArray,
)

/** One attachment re-assembled for a flush dispatch or a restored optimistic bubble. */
class LoadedOutboxAttachment(
  val attachment: ChatOutboxAttachment,
  val bytes: ByteArray,
)

sealed interface ChatOutboxEnqueueResult {
  data class Queued(
    val item: ChatOutboxItem,
  ) : ChatOutboxEnqueueResult

  data object QueueFull : ChatOutboxEnqueueResult

  /** One command's attachments exceed [OUTBOX_MAX_COMMAND_ATTACHMENT_BYTES]; deleting rows cannot help. */
  data object AttachmentsTooLarge : ChatOutboxEnqueueResult

  /** The per-gateway attachment byte budget is exhausted; deleting queued rows frees space. */
  data object StorageFull : ChatOutboxEnqueueResult

  /** No gateway identity is available (nothing paired/configured), so nothing can be queued. */
  data object Unavailable : ChatOutboxEnqueueResult
}

/**
 * Durable outbox for chat sends. Every send is journaled here before any network attempt so
 * process death always has exactly one recovery owner; rows survive until canonical chat.history
 * proves the user turn persisted, they terminally fail, expire, or the user deletes them.
 *
 * Unlike the disposable transcript cache, queued rows are user input that must survive process
 * restarts and schema migrations. Like the cache, callers bind every gateway-scoped operation to
 * an explicit [ChatCacheScope] gateway id captured before their suspend point, so a connection
 * switch cannot re-scope rows mid-operation.
 */
interface ChatCommandOutbox {
  /** All rows for [gatewayId] with attachment metadata, strictly createdAt-ordered. */
  suspend fun load(gatewayId: String): List<ChatOutboxItem>

  suspend fun enqueue(
    gatewayId: String,
    sessionKey: String,
    text: String,
    thinkingLevel: String,
    nowMs: Long,
    attachments: List<OutboxAttachmentPayload> = emptyList(),
    gatedEpoch: Long? = null,
  ): ChatOutboxEnqueueResult

  /** Re-assembles the attachment bytes for one command, in stable position order. */
  suspend fun loadAttachments(id: String): List<LoadedOutboxAttachment>

  /** Returns the number of rows updated (0 when the row no longer exists), so callers can claim. */
  suspend fun updateStatus(
    id: String,
    status: ChatOutboxStatus,
    retryCount: Int,
    lastError: String?,
  ): Int

  /**
   * Atomically claims a queued row for one dispatch (queued -> sending). Returns 0 when the row
   * vanished or another dispatcher already claimed it, so the direct-send path and the flush
   * loop can never both send the same row.
   */
  suspend fun claimForSending(
    id: String,
    retryCount: Int,
    lastError: String?,
  ): Int

  /**
   * Pins a row enqueued under the pre-hello "main" alias to the canonical session key it first
   * resolves to. Replay after that must never re-resolve, so a later default-agent change
   * cannot redirect already-captured input.
   */
  suspend fun pinSessionKey(
    id: String,
    sessionKey: String,
  )

  /**
   * User-driven retry of a failed row owned by [gatewayId]: back to 'queued' with reset attempts
   * and a fresh createdAt, so an expired row is not immediately re-expired by the flush sweep.
   * Returns the number of rows transitioned; keeps the row id as the gateway idempotency key.
   * Gated rows are re-stamped with the caller's current connection epoch, and queued successors
   * in the same session shift behind the retried row in their original order, so retrying an
   * ambiguous head can never make younger turns of the conversation overtake it.
   */
  suspend fun requeueForRetry(
    gatewayId: String,
    id: String,
    nowMs: Long,
    gatedEpoch: Long?,
  ): Int

  suspend fun delete(id: String)

  /** Retires rows proven delivered by canonical history; returns how many rows were removed. */
  suspend fun confirmDelivered(ids: Set<String>): Int

  /** Drops queued commands for a deleted session so they cannot send into a dead session. */
  suspend fun deleteForSession(
    gatewayId: String,
    sessionKey: String,
  )

  /** Drops every queued command owned by one gateway identity. */
  suspend fun clearGateway(gatewayId: String)

  /** Crash safety: rows stuck in 'sending' after a killed process become visible failed rows. */
  suspend fun failSendingAfterRestart()

  /**
   * Expires stale rows to 'failed' instead of sending stale commands: queued rows older than
   * [OUTBOX_EXPIRY_MS] expire, and accepted rows never confirmed within the same window park
   * as delivery-unconfirmed so they stay visible for manual review.
   */
  suspend fun expireStale(
    gatewayId: String,
    nowMs: Long,
  )
}

@Entity(tableName = "outbox_commands")
internal data class OutboxCommandEntity(
  @PrimaryKey val id: String,
  val gatewayId: String,
  val sessionKey: String,
  val text: String,
  val thinkingLevel: String,
  val createdAtMs: Long,
  val status: String,
  val retryCount: Int,
  val lastError: String?,
  val gatedEpoch: Long?,
)

@Entity(
  tableName = "outbox_attachments",
  indices = [Index("commandId")],
)
internal data class OutboxAttachmentEntity(
  @PrimaryKey val id: String,
  val commandId: String,
  val position: Int,
  val type: String,
  val mimeType: String,
  val fileName: String,
  val durationMs: Long?,
  val byteLength: Long,
)

@Entity(
  tableName = "outbox_attachment_chunks",
  primaryKeys = ["attachmentId", "chunkIndex"],
)
internal class OutboxAttachmentChunkEntity(
  val attachmentId: String,
  val chunkIndex: Int,
  @ColumnInfo(typeAffinity = ColumnInfo.BLOB) val bytes: ByteArray,
)

@Dao
internal interface ChatOutboxDao {
  // id tiebreak keeps flush order deterministic when two rows share a createdAt millisecond.
  @Query("SELECT * FROM outbox_commands WHERE gatewayId = :gatewayId ORDER BY createdAtMs ASC, id ASC")
  suspend fun commands(gatewayId: String): List<OutboxCommandEntity>

  @Query("SELECT id FROM outbox_commands WHERE gatewayId = :gatewayId AND sessionKey = :sessionKey")
  suspend fun commandIdsForSession(
    gatewayId: String,
    sessionKey: String,
  ): List<String>

  @Query("SELECT id FROM outbox_commands WHERE gatewayId = :gatewayId")
  suspend fun commandIdsForGateway(gatewayId: String): List<String>

  @Query("SELECT COUNT(*) FROM outbox_commands WHERE gatewayId = :gatewayId")
  suspend fun count(gatewayId: String): Int

  @Query("SELECT MAX(createdAtMs) FROM outbox_commands WHERE gatewayId = :gatewayId")
  suspend fun maxCreatedAt(gatewayId: String): Long?

  @Insert
  suspend fun insert(row: OutboxCommandEntity)

  @Query("UPDATE outbox_commands SET status = :status, retryCount = :retryCount, lastError = :lastError WHERE id = :id")
  suspend fun updateStatus(
    id: String,
    status: String,
    retryCount: Int,
    lastError: String?,
  ): Int

  @Query(
    "UPDATE outbox_commands SET status = :toStatus, retryCount = :retryCount, lastError = :lastError " +
      "WHERE id = :id AND status = :fromStatus",
  )
  suspend fun claimStatus(
    id: String,
    fromStatus: String,
    toStatus: String,
    retryCount: Int,
    lastError: String?,
  ): Int

  @Query("UPDATE outbox_commands SET sessionKey = :sessionKey WHERE id = :id")
  suspend fun updateSessionKey(
    id: String,
    sessionKey: String,
  )

  @Query("UPDATE outbox_commands SET createdAtMs = :createdAtMs WHERE id = :id")
  suspend fun updateCreatedAt(
    id: String,
    createdAtMs: Long,
  )

  @Query("UPDATE outbox_commands SET status = :failedStatus, lastError = :error WHERE status = :sendingStatus")
  suspend fun failAllSending(
    sendingStatus: String,
    failedStatus: String,
    error: String,
  )

  @Query(
    "UPDATE outbox_commands SET status = :queuedStatus, retryCount = 0, lastError = NULL, createdAtMs = :createdAtMs, " +
      "gatedEpoch = :gatedEpoch WHERE id = :id AND gatewayId = :gatewayId AND status = :failedStatus",
  )
  suspend fun requeueForRetry(
    id: String,
    gatewayId: String,
    createdAtMs: Long,
    queuedStatus: String,
    failedStatus: String,
    gatedEpoch: Long?,
  ): Int

  @Query(
    "UPDATE outbox_commands SET status = :failedStatus, lastError = :error " +
      "WHERE gatewayId = :gatewayId AND status = :fromStatus AND createdAtMs <= :cutoffMs",
  )
  suspend fun expireStatusAtOrBefore(
    gatewayId: String,
    cutoffMs: Long,
    fromStatus: String,
    failedStatus: String,
    error: String,
  )

  @Query("DELETE FROM outbox_commands WHERE id = :id")
  suspend fun delete(id: String): Int

  @Query("SELECT * FROM outbox_attachments WHERE commandId IN (:commandIds) ORDER BY position ASC")
  suspend fun attachmentsForCommands(commandIds: List<String>): List<OutboxAttachmentEntity>

  @Query("SELECT * FROM outbox_attachments WHERE commandId = :commandId ORDER BY position ASC")
  suspend fun attachmentsForCommand(commandId: String): List<OutboxAttachmentEntity>

  @Query("SELECT bytes FROM outbox_attachment_chunks WHERE attachmentId = :attachmentId ORDER BY chunkIndex ASC")
  suspend fun chunksForAttachment(attachmentId: String): List<ByteArray>

  @Insert
  suspend fun insertAttachment(row: OutboxAttachmentEntity)

  @Insert
  suspend fun insertChunk(row: OutboxAttachmentChunkEntity)

  @Query(
    "SELECT COALESCE(SUM(byteLength), 0) FROM outbox_attachments WHERE commandId IN " +
      "(SELECT id FROM outbox_commands WHERE gatewayId = :gatewayId)",
  )
  suspend fun attachmentBytesForGateway(gatewayId: String): Long

  @Query(
    "DELETE FROM outbox_attachment_chunks WHERE attachmentId IN " +
      "(SELECT id FROM outbox_attachments WHERE commandId = :commandId)",
  )
  suspend fun deleteChunksForCommand(commandId: String)

  @Query("DELETE FROM outbox_attachments WHERE commandId = :commandId")
  suspend fun deleteAttachmentsForCommand(commandId: String)
}

/**
 * Room-backed [ChatCommandOutbox] sharing the chat cache database. Callers pass the gateway id
 * captured before their suspend point; a blank identity disables both reads and writes.
 * Command rows and their attachment bytes are admitted and retired in single transactions, so
 * a crash can never orphan bytes or strand a row without its attachments.
 */
class RoomChatCommandOutbox internal constructor(
  private val database: ChatCacheDatabase,
) : ChatCommandOutbox {
  override suspend fun load(gatewayId: String): List<ChatOutboxItem> {
    val gateway = scopedGatewayId(gatewayId) ?: return emptyList()
    val dao = database.outboxDao()
    val rows = dao.commands(gateway)
    if (rows.isEmpty()) return emptyList()
    val attachmentsByCommand = dao.attachmentsForCommands(rows.map { it.id }).groupBy { it.commandId }
    return rows.map { row -> row.toItem(attachmentsByCommand[row.id].orEmpty()) }
  }

  override suspend fun enqueue(
    gatewayId: String,
    sessionKey: String,
    text: String,
    thinkingLevel: String,
    nowMs: Long,
    attachments: List<OutboxAttachmentPayload>,
    gatedEpoch: Long?,
  ): ChatOutboxEnqueueResult {
    val gateway = scopedGatewayId(gatewayId) ?: return ChatOutboxEnqueueResult.Unavailable
    val key = sessionKey.trim().takeIf { it.isNotEmpty() } ?: return ChatOutboxEnqueueResult.Unavailable
    val attachmentBytes = attachments.sumOf { it.bytes.size.toLong() }
    if (attachmentBytes > OUTBOX_MAX_COMMAND_ATTACHMENT_BYTES) {
      return ChatOutboxEnqueueResult.AttachmentsTooLarge
    }
    val dao = database.outboxDao()
    // Admission is one transaction: capacity checks plus the command, attachment, and chunk
    // rows commit atomically, so durable admission is all-or-nothing across a crash. The row
    // bound counts every row (failed included) so total storage stays capped; failed rows are
    // user-visible and deletable, so a full queue is always recoverable from the UI.
    return database.withTransaction {
      if (dao.count(gateway) >= OUTBOX_MAX_QUEUED) {
        return@withTransaction ChatOutboxEnqueueResult.QueueFull
      }
      if (attachmentBytes > 0 &&
        dao.attachmentBytesForGateway(gateway) + attachmentBytes > OUTBOX_MAX_GATEWAY_ATTACHMENT_BYTES
      ) {
        return@withTransaction ChatOutboxEnqueueResult.StorageFull
      }
      // Monotonic per-gateway createdAt keeps flush strictly FIFO even when two sends land
      // in the same wall-clock millisecond (the id tiebreak is a random UUID otherwise).
      val createdAt = maxOf(nowMs, (dao.maxCreatedAt(gateway) ?: Long.MIN_VALUE) + 1)
      val entity =
        OutboxCommandEntity(
          id = UUID.randomUUID().toString(),
          gatewayId = gateway,
          sessionKey = key,
          text = text,
          thinkingLevel = thinkingLevel,
          createdAtMs = createdAt,
          status = ChatOutboxStatus.Queued.dbValue,
          retryCount = 0,
          lastError = null,
          gatedEpoch = gatedEpoch,
        )
      dao.insert(entity)
      val storedAttachments =
        attachments.mapIndexed { position, payload ->
          val attachmentEntity =
            OutboxAttachmentEntity(
              id = UUID.randomUUID().toString(),
              commandId = entity.id,
              position = position,
              type = payload.type,
              mimeType = payload.mimeType,
              fileName = payload.fileName,
              durationMs = payload.durationMs,
              byteLength = payload.bytes.size.toLong(),
            )
          dao.insertAttachment(attachmentEntity)
          var chunkIndex = 0
          var offset = 0
          while (offset < payload.bytes.size) {
            val end = minOf(offset + OUTBOX_ATTACHMENT_CHUNK_BYTES, payload.bytes.size)
            dao.insertChunk(
              OutboxAttachmentChunkEntity(
                attachmentId = attachmentEntity.id,
                chunkIndex = chunkIndex,
                bytes = payload.bytes.copyOfRange(offset, end),
              ),
            )
            chunkIndex += 1
            offset = end
          }
          attachmentEntity
        }
      ChatOutboxEnqueueResult.Queued(entity.toItem(storedAttachments))
    }
  }

  override suspend fun loadAttachments(id: String): List<LoadedOutboxAttachment> {
    val dao = database.outboxDao()
    return dao.attachmentsForCommand(id).map { row ->
      val chunks = dao.chunksForAttachment(row.id)
      val bytes = ByteArray(chunks.sumOf { it.size })
      var offset = 0
      for (chunk in chunks) {
        chunk.copyInto(bytes, offset)
        offset += chunk.size
      }
      LoadedOutboxAttachment(attachment = row.toAttachment(), bytes = bytes)
    }
  }

  override suspend fun updateStatus(
    id: String,
    status: ChatOutboxStatus,
    retryCount: Int,
    lastError: String?,
  ): Int = database.outboxDao().updateStatus(id = id, status = status.dbValue, retryCount = retryCount, lastError = lastError)

  override suspend fun claimForSending(
    id: String,
    retryCount: Int,
    lastError: String?,
  ): Int =
    database.outboxDao().claimStatus(
      id = id,
      fromStatus = ChatOutboxStatus.Queued.dbValue,
      toStatus = ChatOutboxStatus.Sending.dbValue,
      retryCount = retryCount,
      lastError = lastError,
    )

  override suspend fun pinSessionKey(
    id: String,
    sessionKey: String,
  ) {
    val key = sessionKey.trim().takeIf { it.isNotEmpty() } ?: return
    database.outboxDao().updateSessionKey(id = id, sessionKey = key)
  }

  override suspend fun requeueForRetry(
    gatewayId: String,
    id: String,
    nowMs: Long,
    gatedEpoch: Long?,
  ): Int {
    val gateway = scopedGatewayId(gatewayId) ?: return 0
    val dao = database.outboxDao()
    return database.withTransaction {
      val rows = dao.commands(gateway)
      val target = rows.firstOrNull { it.id == id } ?: return@withTransaction 0
      // Same monotonic clamp as enqueue: the fresh createdAt keeps the expiry sweep from
      // immediately re-failing a retried stale row.
      var createdAt = maxOf(nowMs, (dao.maxCreatedAt(gateway) ?: Long.MIN_VALUE) + 1)
      val transitioned =
        dao.requeueForRetry(
          id = id,
          gatewayId = gateway,
          createdAtMs = createdAt,
          queuedStatus = ChatOutboxStatus.Queued.dbValue,
          failedStatus = ChatOutboxStatus.Failed.dbValue,
          gatedEpoch = gatedEpoch,
        )
      if (transitioned > 0) {
        // Queued same-session successors follow the retried row in their original order, so
        // retrying an ambiguous head cannot let younger conversation turns overtake it.
        for (successor in rows) {
          val follows =
            successor.id != id &&
              successor.sessionKey == target.sessionKey &&
              successor.createdAtMs > target.createdAtMs &&
              ChatOutboxStatus.fromDb(successor.status) == ChatOutboxStatus.Queued
          if (follows) {
            createdAt += 1
            dao.updateCreatedAt(id = successor.id, createdAtMs = createdAt)
          }
        }
      }
      transitioned
    }
  }

  override suspend fun delete(id: String) {
    database.withTransaction {
      deleteCommandRowLocked(id)
    }
  }

  override suspend fun confirmDelivered(ids: Set<String>): Int {
    if (ids.isEmpty()) return 0
    return database.withTransaction {
      var removed = 0
      for (id in ids) {
        removed += deleteCommandRowLocked(id)
      }
      removed
    }
  }

  override suspend fun deleteForSession(
    gatewayId: String,
    sessionKey: String,
  ) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    val key = sessionKey.trim().takeIf { it.isNotEmpty() } ?: return
    val dao = database.outboxDao()
    database.withTransaction {
      for (id in dao.commandIdsForSession(gateway, key)) {
        deleteCommandRowLocked(id)
      }
    }
  }

  override suspend fun clearGateway(gatewayId: String) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    val dao = database.outboxDao()
    database.withTransaction {
      for (id in dao.commandIdsForGateway(gateway)) {
        deleteCommandRowLocked(id)
      }
    }
  }

  override suspend fun failSendingAfterRestart() {
    // Deliberately unscoped: recovery happens before a gateway is resolved, but a crash leaves
    // delivery ambiguous and must not silently replay an already accepted command.
    database.outboxDao().failAllSending(
      sendingStatus = ChatOutboxStatus.Sending.dbValue,
      failedStatus = ChatOutboxStatus.Failed.dbValue,
      error = OUTBOX_DELIVERY_UNCONFIRMED_ERROR,
    )
  }

  override suspend fun expireStale(
    gatewayId: String,
    nowMs: Long,
  ) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    val dao = database.outboxDao()
    val cutoff = nowMs - OUTBOX_EXPIRY_MS
    database.withTransaction {
      dao.expireStatusAtOrBefore(
        gatewayId = gateway,
        cutoffMs = cutoff,
        fromStatus = ChatOutboxStatus.Queued.dbValue,
        failedStatus = ChatOutboxStatus.Failed.dbValue,
        error = OUTBOX_EXPIRED_ERROR,
      )
      // Accepted rows the gateway never confirmed within the window stay visible as failed
      // instead of silently occupying the queue forever.
      dao.expireStatusAtOrBefore(
        gatewayId = gateway,
        cutoffMs = cutoff,
        fromStatus = ChatOutboxStatus.Accepted.dbValue,
        failedStatus = ChatOutboxStatus.Failed.dbValue,
        error = OUTBOX_DELIVERY_UNCONFIRMED_ERROR,
      )
    }
  }

  // Attachment chunk and metadata rows must die with their command row in the same
  // transaction; callers wrap this in database.withTransaction.
  private suspend fun deleteCommandRowLocked(id: String): Int {
    val dao = database.outboxDao()
    dao.deleteChunksForCommand(id)
    dao.deleteAttachmentsForCommand(id)
    return dao.delete(id)
  }

  private fun scopedGatewayId(gatewayId: String): String? = gatewayId.trim().takeIf { it.isNotEmpty() }
}

private fun OutboxCommandEntity.toItem(attachments: List<OutboxAttachmentEntity>): ChatOutboxItem =
  ChatOutboxItem(
    id = id,
    sessionKey = sessionKey,
    text = text,
    thinkingLevel = thinkingLevel,
    createdAtMs = createdAtMs,
    status = ChatOutboxStatus.fromDb(status),
    retryCount = retryCount,
    lastError = lastError,
    gatedEpoch = gatedEpoch,
    attachments = attachments.map { it.toAttachment() },
  )

private fun OutboxAttachmentEntity.toAttachment(): ChatOutboxAttachment =
  ChatOutboxAttachment(
    id = id,
    type = type,
    mimeType = mimeType,
    fileName = fileName,
    durationMs = durationMs,
    byteLength = byteLength,
  )
