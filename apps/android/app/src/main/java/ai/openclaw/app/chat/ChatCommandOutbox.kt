package ai.openclaw.app.chat

import androidx.room.Dao
import androidx.room.Entity
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

enum class ChatOutboxStatus(
  internal val dbValue: String,
) {
  Queued("queued"),
  Sending("sending"),
  Failed("failed"),
  ;

  internal companion object {
    // Destructive migration keeps the schema in lockstep, so unknown values should not occur;
    // park anything unexpected as Failed so it stays visible instead of silently sending.
    fun fromDb(value: String): ChatOutboxStatus = entries.firstOrNull { it.dbValue == value } ?: Failed
  }
}

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
)

sealed interface ChatOutboxEnqueueResult {
  data class Queued(
    val item: ChatOutboxItem,
  ) : ChatOutboxEnqueueResult

  data object QueueFull : ChatOutboxEnqueueResult

  /** No gateway identity is available (nothing paired/configured), so nothing can be queued. */
  data object Unavailable : ChatOutboxEnqueueResult
}

/**
 * Durable offline outbox for text chat commands.
 *
 * Unlike the disposable transcript cache, queued rows are user input that must survive process
 * restarts until they are acked by the gateway, expired, or explicitly deleted. Like the cache,
 * callers bind every gateway-scoped operation to an explicit [ChatCacheScope] gateway id captured
 * before their suspend point, so a connection switch cannot re-scope rows mid-operation.
 */
interface ChatCommandOutbox {
  /** All rows for [gatewayId], strictly createdAt-ordered. */
  suspend fun load(gatewayId: String): List<ChatOutboxItem>

  suspend fun enqueue(
    gatewayId: String,
    sessionKey: String,
    text: String,
    thinkingLevel: String,
    nowMs: Long,
  ): ChatOutboxEnqueueResult

  /** Returns the number of rows updated (0 when the row no longer exists), so callers can claim. */
  suspend fun updateStatus(
    id: String,
    status: ChatOutboxStatus,
    retryCount: Int,
    lastError: String?,
  ): Int

  /**
   * User-driven retry of a failed row owned by [gatewayId]: back to 'queued' with reset attempts
   * and a fresh createdAt, so an expired row is not immediately re-expired by the flush sweep.
   * Returns the number of rows transitioned; keeps the row id as the gateway idempotency key.
   */
  suspend fun requeueForRetry(
    gatewayId: String,
    id: String,
    nowMs: Long,
  ): Int

  suspend fun delete(id: String)

  /** Drops queued commands for a deleted session so they cannot send into a dead session. */
  suspend fun deleteForSession(
    gatewayId: String,
    sessionKey: String,
  )

  /** Drops every queued command owned by one gateway identity. */
  suspend fun clearGateway(gatewayId: String)

  /** Crash safety: rows stuck in 'sending' after a killed process become visible failed rows. */
  suspend fun failSendingAfterRestart()

  /** Expires queued rows older than [OUTBOX_EXPIRY_MS] to 'failed' instead of sending stale commands. */
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
)

@Dao
internal interface ChatOutboxDao {
  // id tiebreak keeps flush order deterministic when two rows share a createdAt millisecond.
  @Query("SELECT * FROM outbox_commands WHERE gatewayId = :gatewayId ORDER BY createdAtMs ASC, id ASC")
  suspend fun commands(gatewayId: String): List<OutboxCommandEntity>

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

  @Query("UPDATE outbox_commands SET status = :failedStatus, lastError = :error WHERE status = :sendingStatus")
  suspend fun failAllSending(
    sendingStatus: String,
    failedStatus: String,
    error: String,
  )

  @Query(
    "UPDATE outbox_commands SET status = :queuedStatus, retryCount = 0, lastError = NULL, createdAtMs = :createdAtMs " +
      "WHERE id = :id AND gatewayId = :gatewayId AND status = :failedStatus",
  )
  suspend fun requeueForRetry(
    id: String,
    gatewayId: String,
    createdAtMs: Long,
    queuedStatus: String,
    failedStatus: String,
  ): Int

  @Query(
    "UPDATE outbox_commands SET status = :failedStatus, lastError = :error " +
      "WHERE gatewayId = :gatewayId AND status = :queuedStatus AND createdAtMs <= :cutoffMs",
  )
  suspend fun expireQueuedAtOrBefore(
    gatewayId: String,
    cutoffMs: Long,
    queuedStatus: String,
    failedStatus: String,
    error: String,
  )

  @Query("DELETE FROM outbox_commands WHERE id = :id")
  suspend fun delete(id: String)

  @Query("DELETE FROM outbox_commands WHERE gatewayId = :gatewayId AND sessionKey = :sessionKey")
  suspend fun deleteForSession(
    gatewayId: String,
    sessionKey: String,
  )

  @Query("DELETE FROM outbox_commands WHERE gatewayId = :gatewayId")
  suspend fun deleteGateway(gatewayId: String)
}

/**
 * Room-backed [ChatCommandOutbox] sharing the chat cache database. Callers pass the gateway id
 * captured before their suspend point; a blank identity disables both reads and writes.
 */
class RoomChatCommandOutbox internal constructor(
  private val database: ChatCacheDatabase,
) : ChatCommandOutbox {
  override suspend fun load(gatewayId: String): List<ChatOutboxItem> {
    val gateway = scopedGatewayId(gatewayId) ?: return emptyList()
    return database.outboxDao().commands(gateway).map { row ->
      ChatOutboxItem(
        id = row.id,
        sessionKey = row.sessionKey,
        text = row.text,
        thinkingLevel = row.thinkingLevel,
        createdAtMs = row.createdAtMs,
        status = ChatOutboxStatus.fromDb(row.status),
        retryCount = row.retryCount,
        lastError = row.lastError,
      )
    }
  }

  override suspend fun enqueue(
    gatewayId: String,
    sessionKey: String,
    text: String,
    thinkingLevel: String,
    nowMs: Long,
  ): ChatOutboxEnqueueResult {
    val gateway = scopedGatewayId(gatewayId) ?: return ChatOutboxEnqueueResult.Unavailable
    val key = sessionKey.trim().takeIf { it.isNotEmpty() } ?: return ChatOutboxEnqueueResult.Unavailable
    val dao = database.outboxDao()
    // The bound counts every row (failed included) so total storage stays capped; failed rows
    // are user-visible and deletable, so a full queue is always recoverable from the UI.
    val row =
      database.withTransaction {
        if (dao.count(gateway) >= OUTBOX_MAX_QUEUED) {
          null
        } else {
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
            )
          dao.insert(entity)
          entity
        }
      } ?: return ChatOutboxEnqueueResult.QueueFull
    return ChatOutboxEnqueueResult.Queued(
      ChatOutboxItem(
        id = row.id,
        sessionKey = row.sessionKey,
        text = row.text,
        thinkingLevel = row.thinkingLevel,
        createdAtMs = row.createdAtMs,
        status = ChatOutboxStatus.Queued,
        retryCount = 0,
        lastError = null,
      ),
    )
  }

  override suspend fun updateStatus(
    id: String,
    status: ChatOutboxStatus,
    retryCount: Int,
    lastError: String?,
  ): Int = database.outboxDao().updateStatus(id = id, status = status.dbValue, retryCount = retryCount, lastError = lastError)

  override suspend fun requeueForRetry(
    gatewayId: String,
    id: String,
    nowMs: Long,
  ): Int {
    val gateway = scopedGatewayId(gatewayId) ?: return 0
    val dao = database.outboxDao()
    return database.withTransaction {
      // Same monotonic clamp as enqueue: a retried row re-joins the end of the FIFO queue.
      val createdAt = maxOf(nowMs, (dao.maxCreatedAt(gateway) ?: Long.MIN_VALUE) + 1)
      dao.requeueForRetry(
        id = id,
        gatewayId = gateway,
        createdAtMs = createdAt,
        queuedStatus = ChatOutboxStatus.Queued.dbValue,
        failedStatus = ChatOutboxStatus.Failed.dbValue,
      )
    }
  }

  override suspend fun delete(id: String) {
    database.outboxDao().delete(id)
  }

  override suspend fun deleteForSession(
    gatewayId: String,
    sessionKey: String,
  ) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    val key = sessionKey.trim().takeIf { it.isNotEmpty() } ?: return
    database.outboxDao().deleteForSession(gateway, key)
  }

  override suspend fun clearGateway(gatewayId: String) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    database.outboxDao().deleteGateway(gateway)
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
    database.outboxDao().expireQueuedAtOrBefore(
      gatewayId = gateway,
      cutoffMs = nowMs - OUTBOX_EXPIRY_MS,
      queuedStatus = ChatOutboxStatus.Queued.dbValue,
      failedStatus = ChatOutboxStatus.Failed.dbValue,
      error = OUTBOX_EXPIRED_ERROR,
    )
  }

  private fun scopedGatewayId(gatewayId: String): String? = gatewayId.trim().takeIf { it.isNotEmpty() }
}
