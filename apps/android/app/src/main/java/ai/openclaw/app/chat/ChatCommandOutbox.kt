package ai.openclaw.app.chat

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.withTransaction
import java.util.UUID

/** Upper bound of durable outbox rows per gateway; enqueue is refused beyond this. */
internal const val OUTBOX_MAX_QUEUED = 50

/** Crash-left UI receipts retained per Gateway/agent owner after outbox retirement. */
internal const val OUTBOX_ADMISSION_RECEIPTS_PER_ROUTING_OWNER = 16

/** Queued commands older than this are expired instead of sending stale instructions. */
internal const val OUTBOX_EXPIRY_MS = 48L * 60L * 60L * 1000L

/** lastError marker for items expired by [OUTBOX_EXPIRY_MS]; also shown in the UI row. */
internal const val OUTBOX_EXPIRED_ERROR = "expired"

/** Delivery is ambiguous after dispatch without an acknowledgement; retry needs explicit intent. */
internal const val OUTBOX_DELIVERY_UNCONFIRMED_ERROR = "delivery unconfirmed; retry manually"

/** Connection-gated command rows never auto-replay across a reconnect; retry needs explicit intent. */
internal const val OUTBOX_CONNECTION_CHANGED_ERROR = "connection changed before this command was sent; retry manually"

/** Owner-less migrated rows stay parked because their original default agent cannot be proven. */
internal const val OUTBOX_OWNER_CHANGED_ERROR = "chat owner changed before this message was sent; retry from the original chat"

/** User-visible reason for rows parked when their transcript branch loses ownership. */
internal const val OUTBOX_BRANCH_CHANGED_ERROR = "Session branch changed; review and retry this message."

private const val OUTBOX_BRANCH_PARK_MARKER = "\n# branch-park:"
private const val OUTBOX_BRANCH_SWITCH_LEASE_MS = 5L * 60L * 1000L

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
  // Captured at admission and sent explicitly on every replay. Unscoped session keys otherwise
  // follow the gateway's mutable default agent and can cross owners after process restart.
  val ownerAgentId: String?,
  val attachments: List<ChatOutboxAttachment> = emptyList(),
  /** Immutable ownership token for the current delivery decision. */
  val attemptVersion: Int = 1,
  /** Transcript branch generation captured atomically at enqueue/retry. */
  val branchEpoch: Int = 0,
  /** Current scope generation observed with this row snapshot. */
  val scopeBranchEpoch: Int = branchEpoch,
  /** True when a parked delivery may already have reached the gateway. */
  val parkedWasAccepted: Boolean = false,
  /** Preserves ambiguous transport evidence across later branch parking. */
  val hadUnacknowledgedSend: Boolean = false,
)

/** Durable branch ownership uses the same session+agent scope as outbox delivery. */
data class ChatOutboxScope(
  val sessionKey: String,
  val ownerAgentId: String,
)

/** Snapshot captured before history/bootstrap can advance the active transcript tip. */
data class ChatOutboxBranchState(
  val epoch: Int,
  val lastActiveLeafEntryId: String?,
  val hadPendingCommands: Boolean,
  val hadDeliverableCommands: Boolean = hadPendingCommands,
  val switchPendingSinceMs: Long?,
  val needsReconciliation: Boolean,
  val revision: Int,
)

data class ChatOutboxMutationLease(
  val revision: Int,
  val startedAtMs: Long,
)

internal fun chatOutboxDisplayError(lastError: String?): String? = lastError?.substringBefore(OUTBOX_BRANCH_PARK_MARKER)

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
  val supportsBranchCoordination: Boolean
    get() = false

  /** All rows for [gatewayId] with attachment metadata, strictly createdAt-ordered. */
  suspend fun load(gatewayId: String): List<ChatOutboxItem>

  /** True when the exact UI idempotency key committed, even if history retired its command row. */
  suspend fun wasAdmitted(id: String): Boolean

  suspend fun enqueue(
    gatewayId: String,
    sessionKey: String,
    text: String,
    thinkingLevel: String,
    nowMs: Long,
    attachments: List<OutboxAttachmentPayload> = emptyList(),
    gatedEpoch: Long? = null,
    ownerAgentId: String,
    idempotencyKey: String? = null,
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

  /** Attempt-scoped transition; stale delivery callbacks must update nothing. */
  suspend fun updateStatusIfAttempt(
    id: String,
    expectedAttemptVersion: Int,
    status: ChatOutboxStatus,
    retryCount: Int,
    lastError: String?,
    expectedStatus: ChatOutboxStatus? = null,
  ): Int = updateStatus(id, status, retryCount, lastError)

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

  suspend fun claimForSendingIfAttempt(
    id: String,
    expectedAttemptVersion: Int,
    retryCount: Int,
    lastError: String?,
  ): Int = claimForSending(id, retryCount, lastError)

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
    ownerAgentId: String? = null,
  ): Int

  /** Retries only the failure version displayed to the user and may mint a fresh client id. */
  suspend fun requeueForRetryIfCurrent(
    gatewayId: String,
    id: String,
    expectedAttemptVersion: Int,
    expectedRetryCount: Int,
    expectedLastError: String?,
    nowMs: Long,
    gatedEpoch: Long?,
    ownerAgentId: String? = null,
    replacementId: String? = null,
  ): Int = requeueForRetry(gatewayId, id, nowMs, gatedEpoch, ownerAgentId)

  suspend fun delete(id: String)

  /** Deletes only an undispatched row; false means another lane already claimed or retired it. */
  suspend fun deleteIfQueued(id: String): Boolean

  /** Retires rows proven delivered by canonical history; returns how many rows were removed. */
  suspend fun confirmDelivered(ids: Set<String>): Int

  /** Canonical history confirmation for the currently observed delivery attempts. */
  suspend fun confirmDeliveredAttempts(ids: Map<String, Int>): Int = confirmDelivered(ids.keys)

  suspend fun branchState(
    gatewayId: String,
    scope: ChatOutboxScope,
  ): ChatOutboxBranchState? = null

  /** Installs the session-mutation lease only when this scope has no unconfirmed delivery. */
  suspend fun beginSessionMutation(
    gatewayId: String,
    scope: ChatOutboxScope,
    nowMs: Long,
  ): ChatOutboxMutationLease? = null

  suspend fun cancelSessionMutation(
    gatewayId: String,
    scope: ChatOutboxScope,
    lease: ChatOutboxMutationLease,
  ): Boolean = false

  suspend fun demoteSessionMutationToReconciliation(
    gatewayId: String,
    scope: ChatOutboxScope,
    lease: ChatOutboxMutationLease? = null,
  ): Boolean = false

  /** Demotes and returns the same-transaction baseline used to classify later enqueues. */
  suspend fun demoteSessionMutationToReconciliationState(
    gatewayId: String,
    scope: ChatOutboxScope,
    lease: ChatOutboxMutationLease? = null,
  ): ChatOutboxBranchState? = null

  suspend fun updateLastActiveLeafEntryId(
    gatewayId: String,
    scope: ChatOutboxScope,
    leafEntryId: String,
    expectedEpoch: Int,
    expectedRevision: Int,
  ): Boolean = false

  suspend fun reconcileBranchScope(
    gatewayId: String,
    scope: ChatOutboxScope,
    previousState: ChatOutboxBranchState,
    activeLeafEntryId: String?,
    branchLeafEntryIds: Set<String>,
    activeTranscriptEntryIds: Set<String>,
    lastError: String,
  ): Boolean = false

  suspend fun confirmBranchChange(
    gatewayId: String,
    scope: ChatOutboxScope,
    activeLeafEntryId: String?,
    lastError: String,
    lease: ChatOutboxMutationLease? = null,
  ): Boolean = false

  /** Drops queued commands for a deleted session so they cannot send into a dead session. */
  suspend fun deleteForSession(
    gatewayId: String,
    sessionKey: String,
    ownerAgentId: String,
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
  val ownerAgentId: String?,
)

@Entity(tableName = "composer_send_admissions")
internal data class ComposerSendAdmissionEntity(
  @PrimaryKey val id: String,
  val gatewayId: String,
  val ownerAgentId: String,
  val sessionKey: String,
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
  // One-time legacy import reads small metadata sets plus bounded BLOB pages before copying them
  // into client-state. Runtime callers remain gateway-scoped below.
  @Query("SELECT * FROM outbox_commands ORDER BY gatewayId ASC, createdAtMs ASC, id ASC")
  suspend fun allCommands(): List<OutboxCommandEntity>

  @Query("SELECT * FROM composer_send_admissions ORDER BY gatewayId ASC, ownerAgentId ASC, id ASC")
  suspend fun allAdmissionReceipts(): List<ComposerSendAdmissionEntity>

  @Query("SELECT * FROM outbox_attachments ORDER BY commandId ASC, position ASC")
  suspend fun allAttachments(): List<OutboxAttachmentEntity>

  @Query(
    "SELECT * FROM outbox_attachment_chunks " +
      "WHERE :afterAttachmentId IS NULL OR attachmentId > :afterAttachmentId " +
      "OR (attachmentId = :afterAttachmentId AND chunkIndex > :afterChunkIndex) " +
      "ORDER BY attachmentId ASC, chunkIndex ASC LIMIT :limit",
  )
  suspend fun attachmentChunkPage(
    afterAttachmentId: String?,
    afterChunkIndex: Int,
    limit: Int,
  ): List<OutboxAttachmentChunkEntity>

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun upsertImportedCommands(rows: List<OutboxCommandEntity>)

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun upsertImportedAdmissionReceipts(rows: List<ComposerSendAdmissionEntity>)

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun upsertImportedAttachments(rows: List<OutboxAttachmentEntity>)

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun upsertImportedAttachmentChunks(rows: List<OutboxAttachmentChunkEntity>)

  // id tiebreak keeps flush order deterministic when two rows share a createdAt millisecond.
  @Query("SELECT * FROM outbox_commands WHERE gatewayId = :gatewayId ORDER BY createdAtMs ASC, id ASC")
  suspend fun commands(gatewayId: String): List<OutboxCommandEntity>

  @Query("SELECT * FROM outbox_commands WHERE id = :id")
  suspend fun command(id: String): OutboxCommandEntity?

  @Query(
    "SELECT id FROM outbox_commands WHERE gatewayId = :gatewayId AND sessionKey = :sessionKey " +
      "AND ownerAgentId = :ownerAgentId",
  )
  suspend fun commandIdsForSession(
    gatewayId: String,
    sessionKey: String,
    ownerAgentId: String,
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
      "gatedEpoch = :gatedEpoch, ownerAgentId = COALESCE(ownerAgentId, :ownerAgentId) " +
      "WHERE id = :id AND gatewayId = :gatewayId AND status = :failedStatus",
  )
  suspend fun requeueForRetry(
    id: String,
    gatewayId: String,
    createdAtMs: Long,
    queuedStatus: String,
    failedStatus: String,
    gatedEpoch: Long?,
    ownerAgentId: String?,
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

  @Query("SELECT status FROM outbox_commands WHERE id = :id")
  suspend fun status(id: String): String?

  @Query("SELECT EXISTS(SELECT 1 FROM composer_send_admissions WHERE id = :id)")
  suspend fun hasAdmissionReceipt(id: String): Boolean

  @Insert
  suspend fun insertAdmissionReceipt(row: ComposerSendAdmissionEntity)

  @Query("DELETE FROM composer_send_admissions WHERE id = :id")
  suspend fun deleteAdmissionReceipt(id: String): Int

  // Live command rows remain recovery proof even during a send burst. The agent-wide window
  // bounds retired receipts across sessions while a lifecycle save catches up with SavedState.
  @Query(
    "DELETE FROM composer_send_admissions WHERE gatewayId = :gatewayId AND ownerAgentId = :ownerAgentId " +
      "AND id NOT IN (SELECT id FROM outbox_commands) " +
      "AND rowid NOT IN " +
      "(SELECT rowid FROM composer_send_admissions WHERE gatewayId = :gatewayId AND ownerAgentId = :ownerAgentId " +
      "AND id NOT IN (SELECT id FROM outbox_commands) " +
      "ORDER BY rowid DESC LIMIT :keep)",
  )
  suspend fun pruneAdmissionReceipts(
    gatewayId: String,
    ownerAgentId: String,
    keep: Int,
  )

  @Query("DELETE FROM composer_send_admissions WHERE gatewayId = :gatewayId")
  suspend fun deleteAdmissionReceiptsForGateway(gatewayId: String)

  @Query(
    "DELETE FROM composer_send_admissions WHERE gatewayId = :gatewayId AND sessionKey = :sessionKey " +
      "AND ownerAgentId = :ownerAgentId",
  )
  suspend fun deleteAdmissionReceiptsForSession(
    gatewayId: String,
    sessionKey: String,
    ownerAgentId: String,
  )

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

  @Query("UPDATE outbox_attachments SET commandId = :replacementId WHERE commandId = :commandId")
  suspend fun replaceAttachmentCommandId(
    commandId: String,
    replacementId: String,
  )
}

/**
 * Room-backed [ChatCommandOutbox] in the durable client-state database. Callers pass the gateway
 * id captured before their suspend point; a blank identity disables both reads and writes.
 * Command rows and their attachment bytes are admitted and retired in single transactions, so
 * a crash can never orphan bytes or strand a row without its attachments.
 */
class RoomChatCommandOutbox internal constructor(
  private val database: ClientStateDatabase,
) : ChatCommandOutbox {
  override val supportsBranchCoordination: Boolean = true

  internal data class DeliveryState(
    val attemptVersion: Int,
    val branchEpoch: Int,
    val parkedWasAccepted: Boolean,
    val hadUnacknowledgedSend: Boolean,
  )

  override suspend fun load(gatewayId: String): List<ChatOutboxItem> {
    val gateway = scopedGatewayId(gatewayId) ?: return emptyList()
    return database.withTransaction {
      ensureBranchStorageLocked()
      val dao = database.outboxDao()
      val rows = dao.commands(gateway)
      if (rows.isEmpty()) return@withTransaction emptyList()
      val attachmentsByCommand = dao.attachmentsForCommands(rows.map { it.id }).groupBy { it.commandId }
      rows.map { row ->
        val scope = row.branchScope()
        ensureBranchScopeLocked(gateway, scope)
        ensureDeliveryStateLocked(row.id, gateway, scope)
        val delivery = checkNotNull(readDeliveryStateLocked(row.id))
        val branch = checkNotNull(readBranchStateLocked(gateway, scope))
        row.toItem(
          attachments = attachmentsByCommand[row.id].orEmpty(),
          deliveryState = delivery,
          scopeBranchEpoch = branch.epoch,
        )
      }
    }
  }

  override suspend fun wasAdmitted(id: String): Boolean {
    val dao = database.outboxDao()
    return dao.status(id) != null || dao.hasAdmissionReceipt(id)
  }

  override suspend fun enqueue(
    gatewayId: String,
    sessionKey: String,
    text: String,
    thinkingLevel: String,
    nowMs: Long,
    attachments: List<OutboxAttachmentPayload>,
    gatedEpoch: Long?,
    ownerAgentId: String,
    idempotencyKey: String?,
  ): ChatOutboxEnqueueResult {
    val gateway = scopedGatewayId(gatewayId) ?: return ChatOutboxEnqueueResult.Unavailable
    val key = sessionKey.trim().takeIf { it.isNotEmpty() } ?: return ChatOutboxEnqueueResult.Unavailable
    val owner = normalizedOutboxOwnerAgentId(ownerAgentId) ?: return ChatOutboxEnqueueResult.Unavailable
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
      ensureBranchStorageLocked()
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
      val requestedId = idempotencyKey?.trim()?.takeIf { it.isNotEmpty() }
      val entity =
        OutboxCommandEntity(
          id = requestedId ?: UUID.randomUUID().toString(),
          gatewayId = gateway,
          sessionKey = key,
          text = text,
          thinkingLevel = thinkingLevel,
          createdAtMs = createdAt,
          status = ChatOutboxStatus.Queued.dbValue,
          retryCount = 0,
          lastError = null,
          gatedEpoch = gatedEpoch,
          ownerAgentId = owner,
        )
      if (requestedId != null) {
        // The receipt commits with the row and outlives history retirement. SavedState can then
        // prove this draft was admitted even if reconnect reconciliation already deleted the row.
        dao.insertAdmissionReceipt(
          ComposerSendAdmissionEntity(
            id = requestedId,
            gatewayId = gateway,
            ownerAgentId = owner,
            sessionKey = key,
          ),
        )
        dao.pruneAdmissionReceipts(
          gatewayId = gateway,
          ownerAgentId = owner,
          keep = OUTBOX_ADMISSION_RECEIPTS_PER_ROUTING_OWNER,
        )
      }
      dao.insert(entity)
      val scope = ChatOutboxScope(sessionKey = key, ownerAgentId = owner)
      ensureBranchScopeLocked(gateway, scope)
      val branchEpoch = checkNotNull(readBranchStateLocked(gateway, scope)).epoch
      insertDeliveryStateLocked(
        commandId = entity.id,
        attemptVersion = 1,
        branchEpoch = branchEpoch,
        parkedWasAccepted = false,
        hadUnacknowledgedSend = false,
      )
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
      ChatOutboxEnqueueResult.Queued(
        entity.toItem(
          attachments = storedAttachments,
          deliveryState = DeliveryState(1, branchEpoch, parkedWasAccepted = false, hadUnacknowledgedSend = false),
          scopeBranchEpoch = branchEpoch,
        ),
      )
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

  override suspend fun updateStatusIfAttempt(
    id: String,
    expectedAttemptVersion: Int,
    status: ChatOutboxStatus,
    retryCount: Int,
    lastError: String?,
    expectedStatus: ChatOutboxStatus?,
  ): Int =
    database.withTransaction {
      ensureBranchStorageLocked()
      val state = readDeliveryStateLocked(id) ?: return@withTransaction 0
      if (state.attemptVersion != expectedAttemptVersion) return@withTransaction 0
      if (expectedStatus != null) {
        val currentStatus = database.outboxDao().status(id) ?: return@withTransaction 0
        if (currentStatus != expectedStatus.dbValue) return@withTransaction 0
      }
      val updated = database.outboxDao().updateStatus(id, status.dbValue, retryCount, lastError)
      if (updated > 0) {
        insertDeliveryStateLocked(
          commandId = id,
          attemptVersion = expectedAttemptVersion + if (status == ChatOutboxStatus.Queued) 1 else 0,
          branchEpoch = state.branchEpoch,
          parkedWasAccepted = state.parkedWasAccepted,
          hadUnacknowledgedSend = true,
        )
      }
      updated
    }

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

  override suspend fun claimForSendingIfAttempt(
    id: String,
    expectedAttemptVersion: Int,
    retryCount: Int,
    lastError: String?,
  ): Int =
    database.withTransaction {
      ensureBranchStorageLocked()
      val dao = database.outboxDao()
      val row = dao.allCommands().firstOrNull { it.id == id } ?: return@withTransaction 0
      val delivery = readDeliveryStateLocked(id) ?: return@withTransaction 0
      if (delivery.attemptVersion != expectedAttemptVersion) return@withTransaction 0
      val scope = row.branchScope()
      ensureBranchScopeLocked(row.gatewayId, scope)
      val branch = readBranchStateLocked(row.gatewayId, scope) ?: return@withTransaction 0
      if (branch.switchPendingSinceMs != null || branch.needsReconciliation || delivery.branchEpoch != branch.epoch) {
        return@withTransaction 0
      }
      dao.claimStatus(
        id = id,
        fromStatus = ChatOutboxStatus.Queued.dbValue,
        toStatus = ChatOutboxStatus.Sending.dbValue,
        retryCount = retryCount,
        lastError = lastError,
      )
    }

  override suspend fun pinSessionKey(
    id: String,
    sessionKey: String,
  ) {
    val key = sessionKey.trim().takeIf { it.isNotEmpty() } ?: return
    database.withTransaction {
      ensureBranchStorageLocked()
      val dao = database.outboxDao()
      val row = dao.command(id) ?: return@withTransaction
      if (row.sessionKey == key) return@withTransaction
      val owner =
        normalizedOutboxOwnerAgentId(row.ownerAgentId)
          ?: throw IllegalStateException("cannot pin an ownerless outbox row")
      val previousScope = row.branchScope()
      ensureBranchScopeLocked(row.gatewayId, previousScope)
      ensureDeliveryStateLocked(id, row.gatewayId, previousScope)
      val delivery = checkNotNull(readDeliveryStateLocked(id))
      val nextScope = ChatOutboxScope(key, owner)
      ensureBranchScopeLocked(row.gatewayId, nextScope)
      val nextBranch = checkNotNull(readBranchStateLocked(row.gatewayId, nextScope))
      check(nextBranch.switchPendingSinceMs == null && !nextBranch.needsReconciliation) {
        "cannot pin into an unreconciled branch scope"
      }
      dao.updateSessionKey(id = id, sessionKey = key)
      insertDeliveryStateLocked(
        commandId = id,
        attemptVersion = delivery.attemptVersion,
        branchEpoch = nextBranch.epoch,
        parkedWasAccepted = delivery.parkedWasAccepted,
        hadUnacknowledgedSend = delivery.hadUnacknowledgedSend,
      )
    }
  }

  override suspend fun requeueForRetry(
    gatewayId: String,
    id: String,
    nowMs: Long,
    gatedEpoch: Long?,
    ownerAgentId: String?,
  ): Int {
    val gateway = scopedGatewayId(gatewayId) ?: return 0
    val current = load(gateway).firstOrNull { it.id == id } ?: return 0
    return requeueForRetryIfCurrent(
      gatewayId = gateway,
      id = id,
      expectedAttemptVersion = current.attemptVersion,
      expectedRetryCount = current.retryCount,
      expectedLastError = current.lastError,
      nowMs = nowMs,
      gatedEpoch = gatedEpoch,
      ownerAgentId = ownerAgentId,
    )
  }

  override suspend fun requeueForRetryIfCurrent(
    gatewayId: String,
    id: String,
    expectedAttemptVersion: Int,
    expectedRetryCount: Int,
    expectedLastError: String?,
    nowMs: Long,
    gatedEpoch: Long?,
    ownerAgentId: String?,
    replacementId: String?,
  ): Int {
    val gateway = scopedGatewayId(gatewayId) ?: return 0
    val dao = database.outboxDao()
    return database.withTransaction {
      ensureBranchStorageLocked()
      val rows = dao.commands(gateway)
      val target = rows.firstOrNull { it.id == id } ?: return@withTransaction 0
      if (
        ChatOutboxStatus.fromDb(target.status) != ChatOutboxStatus.Failed ||
        target.retryCount != expectedRetryCount ||
        target.lastError != expectedLastError
      ) {
        return@withTransaction 0
      }
      val delivery = readDeliveryStateLocked(id) ?: return@withTransaction 0
      if (delivery.attemptVersion != expectedAttemptVersion) return@withTransaction 0
      val owner =
        normalizedOutboxOwnerAgentId(ownerAgentId)
          ?: normalizedOutboxOwnerAgentId(target.ownerAgentId)
          ?: return@withTransaction 0
      val scope = ChatOutboxScope(target.sessionKey, owner)
      ensureBranchScopeLocked(gateway, scope)
      val branchEpoch = checkNotNull(readBranchStateLocked(gateway, scope)).epoch
      val wasBranchParked = target.lastError?.contains(OUTBOX_BRANCH_PARK_MARKER) == true
      val needsFreshIdentity = wasBranchParked && (delivery.parkedWasAccepted || delivery.hadUnacknowledgedSend)
      val requestedReplacement = replacementId?.trim()?.takeIf { it.isNotEmpty() }
      val nextId = if (needsFreshIdentity) requestedReplacement ?: UUID.randomUUID().toString() else id
      var createdAt = maxOf(nowMs, (dao.maxCreatedAt(gateway) ?: Long.MIN_VALUE) + 1)
      database.openHelper.writableDatabase.execSQL(
        "UPDATE outbox_commands SET id = ?, status = ?, retryCount = 0, lastError = NULL, " +
          "createdAtMs = ?, gatedEpoch = ?, ownerAgentId = ? WHERE id = ? AND gatewayId = ? AND status = ?",
        arrayOf<Any?>(
          nextId,
          ChatOutboxStatus.Queued.dbValue,
          createdAt,
          gatedEpoch,
          owner.ifEmpty { null },
          id,
          gateway,
          ChatOutboxStatus.Failed.dbValue,
        ),
      )
      val changed =
        database.openHelper.writableDatabase
          .query("SELECT changes()")
          .use { cursor -> cursor.moveToFirst() && cursor.getInt(0) > 0 }
      if (!changed) {
        return@withTransaction 0
      }
      if (nextId != id) dao.replaceAttachmentCommandId(id, nextId)
      deleteDeliveryStateLocked(id)
      insertDeliveryStateLocked(
        commandId = nextId,
        attemptVersion = if (needsFreshIdentity) 1 else expectedAttemptVersion + 1,
        branchEpoch = branchEpoch,
        parkedWasAccepted = false,
        hadUnacknowledgedSend = false,
      )
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
      1
    }
  }

  override suspend fun delete(id: String) {
    database.withTransaction {
      deleteCommandRowLocked(id)
    }
  }

  override suspend fun deleteIfQueued(id: String): Boolean =
    database.withTransaction {
      val dao = database.outboxDao()
      if (dao.status(id) != ChatOutboxStatus.Queued.dbValue) return@withTransaction false
      val deleted = deleteCommandRowLocked(id) > 0
      if (deleted) dao.deleteAdmissionReceipt(id)
      deleted
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

  override suspend fun confirmDeliveredAttempts(ids: Map<String, Int>): Int {
    if (ids.isEmpty()) return 0
    return database.withTransaction {
      ensureBranchStorageLocked()
      var removed = 0
      for ((id, attemptVersion) in ids) {
        if (readDeliveryStateLocked(id)?.attemptVersion == attemptVersion) {
          removed += deleteCommandRowLocked(id)
        }
      }
      removed
    }
  }

  override suspend fun branchState(
    gatewayId: String,
    scope: ChatOutboxScope,
  ): ChatOutboxBranchState? {
    val gateway = scopedGatewayId(gatewayId) ?: return null
    val normalized = normalizedScope(scope) ?: return null
    return database.withTransaction {
      ensureBranchStorageLocked()
      ensureBranchScopeLocked(gateway, normalized)
      val state = readBranchStateLocked(gateway, normalized) ?: return@withTransaction null
      state.copy(
        hadPendingCommands = unresolvedCountLocked(gateway, normalized, includingFailed = true) > 0,
        hadDeliverableCommands = unresolvedCountLocked(gateway, normalized, includingFailed = false) > 0,
      )
    }
  }

  override suspend fun beginSessionMutation(
    gatewayId: String,
    scope: ChatOutboxScope,
    nowMs: Long,
  ): ChatOutboxMutationLease? {
    val gateway = scopedGatewayId(gatewayId) ?: return null
    val normalized = normalizedScope(scope) ?: return null
    return database.withTransaction {
      ensureBranchStorageLocked()
      ensureBranchScopeLocked(gateway, normalized)
      if (expireBranchSwitchLeaseLocked(gateway, normalized, nowMs)) return@withTransaction null
      val state = readBranchStateLocked(gateway, normalized) ?: return@withTransaction null
      if (
        state.needsReconciliation ||
        state.switchPendingSinceMs != null ||
        unresolvedCountLocked(gateway, normalized, includingFailed = false) > 0
      ) {
        return@withTransaction null
      }
      database.openHelper.writableDatabase.execSQL(
        "UPDATE outbox_branch_scopes SET switchPendingSinceMs = ?, revision = revision + 1 " +
          "WHERE gatewayId = ? AND sessionKey = ? AND ownerAgentId = ? AND switchPendingSinceMs IS NULL",
        arrayOf<Any?>(nowMs, gateway, normalized.sessionKey, normalized.ownerAgentId),
      )
      if (changedRowsLocked() > 0) ChatOutboxMutationLease(state.revision + 1, nowMs) else null
    }
  }

  override suspend fun cancelSessionMutation(
    gatewayId: String,
    scope: ChatOutboxScope,
    lease: ChatOutboxMutationLease,
  ): Boolean = updateBranchMutationState(gatewayId, scope, needsReconciliation = false, lease = lease) != null

  override suspend fun demoteSessionMutationToReconciliation(
    gatewayId: String,
    scope: ChatOutboxScope,
    lease: ChatOutboxMutationLease?,
  ): Boolean = updateBranchMutationState(gatewayId, scope, needsReconciliation = true, lease = lease) != null

  override suspend fun demoteSessionMutationToReconciliationState(
    gatewayId: String,
    scope: ChatOutboxScope,
    lease: ChatOutboxMutationLease?,
  ): ChatOutboxBranchState? = updateBranchMutationState(gatewayId, scope, needsReconciliation = true, lease = lease)

  override suspend fun updateLastActiveLeafEntryId(
    gatewayId: String,
    scope: ChatOutboxScope,
    leafEntryId: String,
    expectedEpoch: Int,
    expectedRevision: Int,
  ): Boolean {
    val gateway = scopedGatewayId(gatewayId) ?: return false
    val normalized = normalizedScope(scope) ?: return false
    val leaf = leafEntryId.trim().takeIf { it.isNotEmpty() } ?: return false
    return database.withTransaction {
      ensureBranchStorageLocked()
      ensureBranchScopeLocked(gateway, normalized)
      val state = readBranchStateLocked(gateway, normalized) ?: return@withTransaction false
      if (
        state.epoch != expectedEpoch ||
        state.revision != expectedRevision ||
        state.switchPendingSinceMs != null ||
        state.needsReconciliation ||
        unresolvedCountLocked(gateway, normalized, includingFailed = false) > 0
      ) {
        return@withTransaction false
      }
      writeBranchStateLocked(gateway, normalized, expectedEpoch, leaf, expectedRevision = expectedRevision)
    }
  }

  override suspend fun reconcileBranchScope(
    gatewayId: String,
    scope: ChatOutboxScope,
    previousState: ChatOutboxBranchState,
    activeLeafEntryId: String?,
    branchLeafEntryIds: Set<String>,
    activeTranscriptEntryIds: Set<String>,
    lastError: String,
  ): Boolean {
    val gateway = scopedGatewayId(gatewayId) ?: return false
    val normalized = normalizedScope(scope) ?: return false
    val leaf = activeLeafEntryId?.trim()?.takeIf { it.isNotEmpty() }
    if (activeLeafEntryId != null && leaf == null) return false
    return database.withTransaction {
      ensureBranchStorageLocked()
      ensureBranchScopeLocked(gateway, normalized)
      val expiredLease = expireBranchSwitchLeaseLocked(gateway, normalized, System.currentTimeMillis())
      val state = readBranchStateLocked(gateway, normalized) ?: return@withTransaction false
      if ((!expiredLease && state.revision != previousState.revision) || state.switchPendingSinceMs != null) {
        return@withTransaction false
      }
      val pending = unresolvedCountLocked(gateway, normalized, includingFailed = true)
      val previousLeaf = previousState.lastActiveLeafEntryId
      val canAdoptQueuedDuringReconciliation =
        previousState.needsReconciliation && !previousState.hadDeliverableCommands
      if (leaf != null && previousLeaf != null && previousLeaf != leaf && previousLeaf in branchLeafEntryIds) {
        installConfirmedBranchChangeLocked(
          gateway,
          normalized,
          state.epoch,
          leaf,
          lastError,
          adoptQueuedCommands = canAdoptQueuedDuringReconciliation,
        )
      } else {
        val advancedOnActivePath = previousLeaf?.let(activeTranscriptEntryIds::contains) == true
        if (previousLeaf != leaf && !advancedOnActivePath && canAdoptQueuedDuringReconciliation) {
          installConfirmedBranchChangeLocked(
            gateway,
            normalized,
            state.epoch,
            leaf,
            lastError,
            adoptQueuedCommands = true,
          )
          return@withTransaction true
        }
        if (
          previousLeaf != leaf &&
          !advancedOnActivePath &&
          ((pending > 0 && (previousState.hadPendingCommands || previousState.needsReconciliation)) || leaf == null)
        ) {
          parkPendingCommandsLocked(gateway, normalized, lastError)
        }
        if (!writeBranchStateLocked(gateway, normalized, state.epoch, leaf, expectedRevision = state.revision)) {
          return@withTransaction false
        }
      }
      true
    }
  }

  override suspend fun confirmBranchChange(
    gatewayId: String,
    scope: ChatOutboxScope,
    activeLeafEntryId: String?,
    lastError: String,
    lease: ChatOutboxMutationLease?,
  ): Boolean {
    val gateway = scopedGatewayId(gatewayId) ?: return false
    val normalized = normalizedScope(scope) ?: return false
    val leaf = activeLeafEntryId?.trim()?.takeIf { it.isNotEmpty() }
    if (activeLeafEntryId != null && leaf == null) return false
    return database.withTransaction {
      ensureBranchStorageLocked()
      ensureBranchScopeLocked(gateway, normalized)
      val state = readBranchStateLocked(gateway, normalized) ?: return@withTransaction false
      if (
        lease != null &&
        (state.revision != lease.revision || state.switchPendingSinceMs != lease.startedAtMs)
      ) {
        return@withTransaction false
      }
      if (state.lastActiveLeafEntryId == leaf) {
        writeBranchStateLocked(gateway, normalized, state.epoch, leaf)
      } else {
        installConfirmedBranchChangeLocked(gateway, normalized, state.epoch, leaf, lastError)
        true
      }
    }
  }

  internal suspend fun confirmBranchChange(
    gatewayId: String,
    scope: ChatOutboxScope,
    activeLeafEntryId: String?,
    lastError: String,
  ): Boolean = confirmBranchChange(gatewayId, scope, activeLeafEntryId, lastError, lease = null)

  override suspend fun deleteForSession(
    gatewayId: String,
    sessionKey: String,
    ownerAgentId: String,
  ) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    val key = sessionKey.trim().takeIf { it.isNotEmpty() } ?: return
    val owner = normalizedOutboxOwnerAgentId(ownerAgentId) ?: return
    val dao = database.outboxDao()
    database.withTransaction {
      ensureBranchStorageLocked()
      for (id in dao.commandIdsForSession(gateway, key, owner)) {
        deleteCommandRowLocked(id)
      }
      dao.deleteAdmissionReceiptsForSession(gateway, key, owner)
      database.openHelper.writableDatabase.execSQL(
        "DELETE FROM outbox_branch_scopes WHERE gatewayId = ? AND sessionKey = ? AND ownerAgentId = ?",
        arrayOf<Any?>(gateway, key, owner),
      )
    }
  }

  override suspend fun clearGateway(gatewayId: String) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    val dao = database.outboxDao()
    database.withTransaction {
      ensureBranchStorageLocked()
      for (id in dao.commandIdsForGateway(gateway)) {
        deleteCommandRowLocked(id)
      }
      dao.deleteAdmissionReceiptsForGateway(gateway)
      database.openHelper.writableDatabase.execSQL(
        "DELETE FROM outbox_branch_scopes WHERE gatewayId = ?",
        arrayOf<Any?>(gateway),
      )
    }
  }

  override suspend fun failSendingAfterRestart() {
    // Deliberately unscoped: recovery happens before a gateway is resolved, but a crash leaves
    // delivery ambiguous and must not silently replay an already accepted command.
    database.withTransaction {
      ensureBranchStorageLocked()
      val sendingRows =
        database
          .outboxDao()
          .allCommands()
          .filter { ChatOutboxStatus.fromDb(it.status) == ChatOutboxStatus.Sending }
      for (row in sendingRows) {
        val scope = row.branchScope()
        ensureBranchScopeLocked(row.gatewayId, scope)
        ensureDeliveryStateLocked(row.id, row.gatewayId, scope)
      }
      database.openHelper.writableDatabase.execSQL(
        "UPDATE outbox_delivery_state SET hadUnacknowledgedSend = 1 WHERE commandId IN " +
          "(SELECT id FROM outbox_commands WHERE status = ?)",
        arrayOf<Any?>(ChatOutboxStatus.Sending.dbValue),
      )
      database.outboxDao().failAllSending(
        sendingStatus = ChatOutboxStatus.Sending.dbValue,
        failedStatus = ChatOutboxStatus.Failed.dbValue,
        error = OUTBOX_DELIVERY_UNCONFIRMED_ERROR,
      )
    }
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
    ensureBranchStorageLocked()
    val dao = database.outboxDao()
    dao.deleteChunksForCommand(id)
    dao.deleteAttachmentsForCommand(id)
    deleteDeliveryStateLocked(id)
    return dao.delete(id)
  }

  private fun ensureBranchStorageLocked() {
    val db = database.openHelper.writableDatabase
    db.execSQL(
      "CREATE TABLE IF NOT EXISTS outbox_branch_scopes (" +
        "gatewayId TEXT NOT NULL, sessionKey TEXT NOT NULL, ownerAgentId TEXT NOT NULL, " +
        "branchEpoch INTEGER NOT NULL DEFAULT 0, lastActiveLeafEntryId TEXT, switchPendingSinceMs INTEGER, " +
        "needsReconciliation INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, " +
        "PRIMARY KEY(gatewayId, sessionKey, ownerAgentId))",
    )
    db.execSQL(
      "CREATE TABLE IF NOT EXISTS outbox_delivery_state (" +
        "commandId TEXT NOT NULL PRIMARY KEY, attemptVersion INTEGER NOT NULL DEFAULT 1, " +
        "branchEpoch INTEGER NOT NULL DEFAULT 0, parkedWasAccepted INTEGER NOT NULL DEFAULT 0, " +
        "hadUnacknowledgedSend INTEGER NOT NULL DEFAULT 0)",
    )
  }

  private fun normalizedScope(scope: ChatOutboxScope): ChatOutboxScope? {
    val key = scope.sessionKey.trim().takeIf { it.isNotEmpty() } ?: return null
    val owner = normalizedOutboxOwnerAgentId(scope.ownerAgentId) ?: return null
    return ChatOutboxScope(key, owner)
  }

  private fun ensureBranchScopeLocked(
    gatewayId: String,
    scope: ChatOutboxScope,
  ) {
    database.openHelper.writableDatabase.execSQL(
      "INSERT OR IGNORE INTO outbox_branch_scopes(" +
        "gatewayId, sessionKey, ownerAgentId, branchEpoch, needsReconciliation, revision" +
        ") VALUES (?, ?, ?, 0, 0, 0)",
      arrayOf<Any?>(gatewayId, scope.sessionKey, scope.ownerAgentId),
    )
  }

  private suspend fun ensureDeliveryStateLocked(
    commandId: String,
    gatewayId: String,
    scope: ChatOutboxScope,
  ) {
    val branchEpoch = readBranchStateLocked(gatewayId, scope)?.epoch ?: 0
    val command = database.outboxDao().command(id = commandId)
    val hadUnacknowledgedSend =
      command?.let { row ->
        ChatOutboxStatus.fromDb(row.status) == ChatOutboxStatus.Failed &&
          chatOutboxDisplayError(row.lastError) == OUTBOX_DELIVERY_UNCONFIRMED_ERROR
      } == true
    database.openHelper.writableDatabase.execSQL(
      "INSERT OR IGNORE INTO outbox_delivery_state(" +
        "commandId, attemptVersion, branchEpoch, parkedWasAccepted, hadUnacknowledgedSend" +
        ") VALUES (?, 1, ?, 0, ?)",
      arrayOf<Any?>(commandId, branchEpoch, hadUnacknowledgedSend.asSqlInt()),
    )
  }

  private fun insertDeliveryStateLocked(
    commandId: String,
    attemptVersion: Int,
    branchEpoch: Int,
    parkedWasAccepted: Boolean,
    hadUnacknowledgedSend: Boolean,
  ) {
    database.openHelper.writableDatabase.execSQL(
      "INSERT OR REPLACE INTO outbox_delivery_state(" +
        "commandId, attemptVersion, branchEpoch, parkedWasAccepted, hadUnacknowledgedSend" +
        ") VALUES (?, ?, ?, ?, ?)",
      arrayOf<Any?>(commandId, attemptVersion, branchEpoch, parkedWasAccepted.asSqlInt(), hadUnacknowledgedSend.asSqlInt()),
    )
  }

  private fun readDeliveryStateLocked(commandId: String): DeliveryState? =
    database.openHelper.writableDatabase
      .query(
        "SELECT attemptVersion, branchEpoch, parkedWasAccepted, hadUnacknowledgedSend " +
          "FROM outbox_delivery_state WHERE commandId = ?",
        arrayOf<Any?>(commandId),
      ).use { cursor ->
        if (!cursor.moveToFirst()) return@use null
        DeliveryState(
          attemptVersion = cursor.getInt(0),
          branchEpoch = cursor.getInt(1),
          parkedWasAccepted = cursor.getInt(2) != 0,
          hadUnacknowledgedSend = cursor.getInt(3) != 0,
        )
      }

  private fun deleteDeliveryStateLocked(commandId: String) {
    database.openHelper.writableDatabase.execSQL(
      "DELETE FROM outbox_delivery_state WHERE commandId = ?",
      arrayOf<Any?>(commandId),
    )
  }

  private fun readBranchStateLocked(
    gatewayId: String,
    scope: ChatOutboxScope,
  ): ChatOutboxBranchState? =
    database.openHelper.writableDatabase
      .query(
        "SELECT branchEpoch, lastActiveLeafEntryId, switchPendingSinceMs, needsReconciliation, revision " +
          "FROM outbox_branch_scopes WHERE gatewayId = ? AND sessionKey = ? AND ownerAgentId = ?",
        arrayOf<Any?>(gatewayId, scope.sessionKey, scope.ownerAgentId),
      ).use { cursor ->
        if (!cursor.moveToFirst()) return@use null
        ChatOutboxBranchState(
          epoch = cursor.getInt(0),
          lastActiveLeafEntryId = cursor.getString(1),
          hadPendingCommands = false,
          switchPendingSinceMs = cursor.getLong(2).takeUnless { cursor.isNull(2) },
          needsReconciliation = cursor.getInt(3) != 0,
          revision = cursor.getInt(4),
        )
      }

  private fun unresolvedCountLocked(
    gatewayId: String,
    scope: ChatOutboxScope,
    includingFailed: Boolean,
  ): Int {
    // Statement fragments are implementation data, not native copy. Assignment statements keep
    // them out of the source-string extractor's conditional-expression heuristic.
    val statuses: String
    if (includingFailed) {
      statuses = "'queued', 'sending', 'accepted', 'failed'"
    } else {
      statuses = "'queued', 'sending', 'accepted'"
    }
    return database.openHelper.writableDatabase
      .query(
        "SELECT COUNT(*) FROM outbox_commands WHERE gatewayId = ? AND sessionKey = ? " +
          "AND COALESCE(ownerAgentId, '') = ? AND status IN ($statuses)",
        arrayOf<Any?>(gatewayId, scope.sessionKey, scope.ownerAgentId),
      ).use { cursor -> if (cursor.moveToFirst()) cursor.getInt(0) else 0 }
  }

  private fun changedRowsLocked(): Int =
    database.openHelper.writableDatabase
      .query("SELECT changes()")
      .use { cursor -> if (cursor.moveToFirst()) cursor.getInt(0) else 0 }

  private fun expireBranchSwitchLeaseLocked(
    gatewayId: String,
    scope: ChatOutboxScope,
    nowMs: Long,
  ): Boolean {
    val cutoff = nowMs - OUTBOX_BRANCH_SWITCH_LEASE_MS
    database.openHelper.writableDatabase.execSQL(
      "UPDATE outbox_branch_scopes SET switchPendingSinceMs = NULL, needsReconciliation = 1, revision = revision + 1 " +
        "WHERE gatewayId = ? AND sessionKey = ? AND ownerAgentId = ? AND switchPendingSinceMs <= ?",
      arrayOf<Any?>(gatewayId, scope.sessionKey, scope.ownerAgentId, cutoff),
    )
    return changedRowsLocked() > 0
  }

  private suspend fun updateBranchMutationState(
    gatewayId: String,
    scope: ChatOutboxScope,
    needsReconciliation: Boolean,
    lease: ChatOutboxMutationLease?,
  ): ChatOutboxBranchState? {
    val gateway = scopedGatewayId(gatewayId) ?: return null
    val normalized = normalizedScope(scope) ?: return null
    return database.withTransaction {
      ensureBranchStorageLocked()
      ensureBranchScopeLocked(gateway, normalized)
      if (lease == null) {
        database.openHelper.writableDatabase.execSQL(
          "UPDATE outbox_branch_scopes SET switchPendingSinceMs = NULL, needsReconciliation = ?, revision = revision + 1 " +
            "WHERE gatewayId = ? AND sessionKey = ? AND ownerAgentId = ?",
          arrayOf<Any?>(needsReconciliation.asSqlInt(), gateway, normalized.sessionKey, normalized.ownerAgentId),
        )
      } else {
        database.openHelper.writableDatabase.execSQL(
          "UPDATE outbox_branch_scopes SET switchPendingSinceMs = NULL, needsReconciliation = ?, revision = revision + 1 " +
            "WHERE gatewayId = ? AND sessionKey = ? AND ownerAgentId = ? AND revision = ? AND switchPendingSinceMs = ?",
          arrayOf<Any?>(
            needsReconciliation.asSqlInt(),
            gateway,
            normalized.sessionKey,
            normalized.ownerAgentId,
            lease.revision,
            lease.startedAtMs,
          ),
        )
      }
      if (changedRowsLocked() == 0) return@withTransaction null
      val state = readBranchStateLocked(gateway, normalized) ?: return@withTransaction null
      state.copy(
        hadPendingCommands = unresolvedCountLocked(gateway, normalized, includingFailed = true) > 0,
        hadDeliverableCommands = unresolvedCountLocked(gateway, normalized, includingFailed = false) > 0,
      )
    }
  }

  private fun writeBranchStateLocked(
    gatewayId: String,
    scope: ChatOutboxScope,
    epoch: Int,
    lastActiveLeafEntryId: String?,
    expectedRevision: Int? = null,
  ): Boolean {
    database.openHelper.writableDatabase.execSQL(
      "UPDATE outbox_branch_scopes SET branchEpoch = ?, lastActiveLeafEntryId = ?, switchPendingSinceMs = NULL, " +
        "needsReconciliation = 0, revision = revision + 1 WHERE gatewayId = ? AND sessionKey = ? " +
        "AND ownerAgentId = ? AND (? IS NULL OR revision = ?)",
      arrayOf<Any?>(
        epoch,
        lastActiveLeafEntryId,
        gatewayId,
        scope.sessionKey,
        scope.ownerAgentId,
        expectedRevision,
        expectedRevision,
      ),
    )
    return changedRowsLocked() > 0
  }

  private fun installConfirmedBranchChangeLocked(
    gatewayId: String,
    scope: ChatOutboxScope,
    previousEpoch: Int,
    activeLeafEntryId: String?,
    lastError: String,
    adoptQueuedCommands: Boolean = false,
  ) {
    val nextEpoch = previousEpoch + 1
    check(writeBranchStateLocked(gatewayId, scope, nextEpoch, activeLeafEntryId))
    if (adoptQueuedCommands) {
      database.openHelper.writableDatabase.execSQL(
        "UPDATE outbox_delivery_state SET branchEpoch = ? WHERE commandId IN (" +
          "SELECT id FROM outbox_commands WHERE gatewayId = ? AND sessionKey = ? " +
          "AND COALESCE(ownerAgentId, '') = ? AND status = 'queued')",
        arrayOf<Any?>(nextEpoch, gatewayId, scope.sessionKey, scope.ownerAgentId),
      )
    }
    parkPendingCommandsLocked(gatewayId, scope, lastError, retainedEpoch = nextEpoch)
  }

  private fun parkPendingCommandsLocked(
    gatewayId: String,
    scope: ChatOutboxScope,
    lastError: String,
    retainedEpoch: Int? = null,
  ) {
    val db = database.openHelper.writableDatabase
    val scopeArgs = arrayOf<Any?>(gatewayId, scope.sessionKey, scope.ownerAgentId)
    val epochFilter: String
    if (retainedEpoch == null) {
      epochFilter = ""
    } else {
      epochFilter = " AND branchEpoch <> ?"
    }
    val epochArgs: List<Any?> = if (retainedEpoch == null) emptyList() else listOf(retainedEpoch)
    db.execSQL(
      "UPDATE outbox_delivery_state SET parkedWasAccepted = CASE WHEN hadUnacknowledgedSend = 1 OR commandId IN (" +
        "SELECT id FROM outbox_commands WHERE gatewayId = ? AND sessionKey = ? AND COALESCE(ownerAgentId, '') = ? " +
        "AND status IN ('sending', 'accepted')) THEN 1 ELSE parkedWasAccepted END WHERE commandId IN (" +
        "SELECT id FROM outbox_commands WHERE gatewayId = ? AND sessionKey = ? AND COALESCE(ownerAgentId, '') = ? " +
        "AND status IN ('queued', 'sending', 'accepted', 'failed'))$epochFilter",
      (scopeArgs.toList() + scopeArgs.toList() + epochArgs).toTypedArray(),
    )
    db.execSQL(
      "UPDATE outbox_commands SET status = ?, lastError = ? WHERE gatewayId = ? AND sessionKey = ? " +
        "AND COALESCE(ownerAgentId, '') = ? AND status IN ('queued', 'sending', 'accepted', 'failed') " +
        "AND id IN (SELECT commandId FROM outbox_delivery_state WHERE 1 = 1$epochFilter)",
      arrayOf<Any?>(
        ChatOutboxStatus.Failed.dbValue,
        lastError + OUTBOX_BRANCH_PARK_MARKER + UUID.randomUUID(),
        gatewayId,
        scope.sessionKey,
        scope.ownerAgentId,
      ).toList().plus(epochArgs).toTypedArray(),
    )
  }

  private fun scopedGatewayId(gatewayId: String): String? = gatewayId.trim().takeIf { it.isNotEmpty() }
}

private fun normalizedOutboxOwnerAgentId(value: String?): String? =
  value
    ?.trim()
    ?.lowercase()
    ?.takeIf { it.isNotEmpty() }

private fun OutboxCommandEntity.branchScope(): ChatOutboxScope = ChatOutboxScope(sessionKey = sessionKey, ownerAgentId = normalizedOutboxOwnerAgentId(ownerAgentId).orEmpty())

private fun Boolean.asSqlInt(): Int = if (this) 1 else 0

private fun OutboxCommandEntity.toItem(
  attachments: List<OutboxAttachmentEntity>,
  deliveryState: RoomChatCommandOutbox.DeliveryState,
  scopeBranchEpoch: Int,
): ChatOutboxItem =
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
    ownerAgentId = ownerAgentId,
    attachments = attachments.map { it.toAttachment() },
    attemptVersion = deliveryState.attemptVersion,
    branchEpoch = deliveryState.branchEpoch,
    scopeBranchEpoch = scopeBranchEpoch,
    parkedWasAccepted = deliveryState.parkedWasAccepted,
    hadUnacknowledgedSend = deliveryState.hadUnacknowledgedSend,
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
