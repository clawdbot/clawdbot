package ai.openclaw.app.voice

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

internal data class RealtimeAgentSession(
  val relaySessionId: String,
  val sessionKey: String,
)

private data class RealtimeAgentRun(
  val callId: String,
  val session: RealtimeAgentSession,
)

private data class RealtimeAgentCompletion(
  val sessionKey: String?,
  val state: String,
  val message: JsonElement?,
)

internal data class RealtimeAgentUnhandledCompletion(
  val sessionKey: String?,
  val runId: String,
  val state: String,
  val message: JsonElement?,
)

private class RealtimeAgentPendingCall(
  val callId: String,
  val session: RealtimeAgentSession,
) {
  var job: Job? = null
  var failed = false
}

private data class RealtimeAgentCacheOverflow(
  val unhandled: List<RealtimeAgentUnhandledCompletion>,
  val failedCalls: List<RealtimeAgentPendingCall>,
)

private data class RealtimeAgentPendingFinish(
  val canSubmitError: Boolean,
  val unhandled: List<RealtimeAgentUnhandledCompletion>,
)

private data class RealtimeAgentRunRegistration(
  val completion: RealtimeAgentCompletion?,
  val errorMessage: String?,
  val unhandled: List<RealtimeAgentUnhandledCompletion>,
)

/**
 * Owns Android's provider-tool-call lifecycle for every realtime Talk surface.
 * Replacing the session cancels session-owned work while retaining bounded
 * correlation for late Gateway responses; transport replacement cancels both.
 */
internal class RealtimeAgentCoordinator(
  parentScope: CoroutineScope,
  private val requestGateway: suspend (method: String, paramsJson: String?, timeoutMs: Long) -> String,
  private val onWorking: (RealtimeAgentSession) -> Unit = {},
  private val onError: (RealtimeAgentSession, String) -> Unit = { _, message ->
    Log.w(TAG, message)
  },
  private val onUnhandledCompletion: (RealtimeAgentUnhandledCompletion) -> Unit = {},
  private val maxCachedCompletions: Int = MAX_CACHED_COMPLETIONS,
) {
  private val json = Json { ignoreUnknownKeys = true }
  private val lock = Any()
  private val parentContext = parentScope.coroutineContext
  private val parentJob = parentContext[Job]
  private var transportGeneration = Any()
  private var activeSession: RealtimeAgentSession? = null
  private var sessionScope: CoroutineScope? = null
  private val correlationJobs = LinkedHashSet<Job>()
  private val runs = LinkedHashMap<String, RealtimeAgentRun>()
  private val pendingCalls = LinkedHashSet<RealtimeAgentPendingCall>()
  private val earlyCompletions = LinkedHashMap<String, RealtimeAgentCompletion>()

  // A replacement can reuse the same chat session key, so keep known old run IDs
  // long enough to consume delayed finals instead of leaking them into normal Talk TTS.
  private val retiredRunIds = LinkedHashSet<String>()

  init {
    require(maxCachedCompletions > 0)
  }

  fun beginSession(session: RealtimeAgentSession) {
    val unhandled =
      synchronized(lock) {
        if (activeSession == session) return
        clearSessionLocked().also {
          activeSession = session
          sessionScope = CoroutineScope(parentContext + SupervisorJob(parentJob))
        }
      }
    unhandled.forEach(onUnhandledCompletion)
  }

  fun endSession(expectedRelaySessionId: String? = null) {
    val unhandled =
      synchronized(lock) {
        if (expectedRelaySessionId != null && activeSession?.relaySessionId != expectedRelaySessionId) return
        clearSessionLocked()
      }
    unhandled.forEach(onUnhandledCompletion)
  }

  /** Cancels requests that must not survive a Gateway or account replacement. */
  fun resetTransport() {
    // Lazy correlation jobs can complete synchronously during cancellation. Drop
    // account-bound state first so their handlers cannot release stale output.
    val staleJobs =
      synchronized(lock) {
        clearSessionLocked()
        transportGeneration = Any()
        val jobs = correlationJobs.toList()
        correlationJobs.clear()
        pendingCalls.clear()
        earlyCompletions.clear()
        jobs
      }
    staleJobs.forEach(Job::cancel)
  }

  fun handleToolCall(
    callId: String,
    name: String,
    args: JsonElement?,
    forced: Boolean,
  ): Boolean {
    val sessionAndScopes =
      synchronized(lock) {
        val session = activeSession ?: return false
        val resultScope = sessionScope ?: return false
        Triple(session, resultScope, transportGeneration)
      }
    val (session, resultScope, generation) = sessionAndScopes
    when (name) {
      AGENT_CONSULT_TOOL -> {
        val pendingCall = RealtimeAgentPendingCall(callId = callId, session = session)
        val accepted =
          synchronized(lock) {
            activeSession == session &&
              pendingCalls.size + runs.size < maxCachedCompletions &&
              pendingCalls.add(pendingCall)
          }
        if (accepted) {
          val supervisor = SupervisorJob(parentJob)
          val job =
            CoroutineScope(parentContext + supervisor).launch(start = CoroutineStart.LAZY) {
              runConsult(pendingCall, args, forced)
            }
          job.invokeOnCompletion {
            supervisor.cancel()
            synchronized(lock) { correlationJobs.remove(job) }
            finishPending(pendingCall).unhandled.forEach(onUnhandledCompletion)
          }
          val shouldStart =
            synchronized(lock) {
              if (
                activeSession == session &&
                transportGeneration === generation &&
                isPendingLocked(pendingCall)
              ) {
                pendingCall.job = job
                correlationJobs += job
                true
              } else {
                false
              }
            }
          if (shouldStart) job.start() else job.cancel()
        } else {
          resultScope.launch { submitError(session, callId, "too many concurrent realtime Talk tool calls") }
        }
      }
      AGENT_CONTROL_TOOL -> resultScope.launch { runControl(session, callId, args) }
      else -> resultScope.launch { submitError(session, callId, "unsupported realtime Talk tool: $name") }
    }
    return true
  }

  fun handleChatEvent(
    sessionKey: String?,
    runId: String,
    state: String,
    message: JsonElement?,
  ): Boolean {
    if (state !in TERMINAL_STATES) return false
    val completion = RealtimeAgentCompletion(sessionKey = sessionKey, state = state, message = message)
    var dispatch: Pair<RealtimeAgentRun, RealtimeAgentCompletion>? = null
    var overflow: RealtimeAgentCacheOverflow? = null
    val handled =
      synchronized(lock) {
        if (runId in retiredRunIds) return@synchronized true
        val run = runs[runId]
        if (run != null && (sessionKey == null || sessionKey == run.session.sessionKey)) {
          runs.remove(runId)
          retireRunLocked(runId)
          if (run.session == activeSession) {
            dispatch = run to completion
          }
          true
        } else if (run != null) {
          false
        } else if (hasPendingCallForSessionLocked(sessionKey)) {
          overflow = cacheEarlyCompletionLocked(runId, completion)
          true
        } else {
          false
        }
      }
    dispatch?.let { dispatchCompletion(it.first, it.second) }
    overflow?.let { result ->
      result.unhandled.forEach(onUnhandledCompletion)
      failOverflowedCalls(result.failedCalls)
    }
    return handled
  }

  private suspend fun runConsult(
    pendingCall: RealtimeAgentPendingCall,
    args: JsonElement?,
    forced: Boolean,
  ) {
    val session = pendingCall.session
    val callId = pendingCall.callId
    try {
      if (forced) submitWorking(session, callId)
      if (!isActive(session)) return
      val params =
        buildJsonObject {
          put("sessionKey", JsonPrimitive(session.sessionKey))
          put("callId", JsonPrimitive(callId))
          put("name", JsonPrimitive(AGENT_CONSULT_TOOL))
          put("relaySessionId", JsonPrimitive(session.relaySessionId))
          if (args != null) put("args", args)
        }
      val response = requestGateway("talk.client.toolCall", params.toString(), TOOL_CALL_TIMEOUT_MILLIS)
      val runId = parseRunId(response)
      if (runId.isNullOrBlank()) {
        val finish = finishPending(pendingCall)
        finish.unhandled.forEach(onUnhandledCompletion)
        if (finish.canSubmitError) submitError(session, callId, "tool call returned no run id")
        return
      }
      if (!isPending(pendingCall)) {
        synchronized(lock) { retireRunLocked(runId) }
        return
      }
      // Surface callbacks may take their own lifecycle locks, so never invoke one
      // while holding the coordinator lock. A final racing this callback is cached
      // against the pending call and consumed immediately after registration.
      if (isActive(session)) onWorking(session)
      val registration =
        synchronized(lock) {
          if (!isPendingLocked(pendingCall)) {
            retireRunLocked(runId)
            return
          }
          val cached = earlyCompletions.remove(runId)
          pendingCalls.remove(pendingCall)
          var errorMessage: String? = null
          if (activeSession == session) {
            if (cached == null) {
              if (runId in retiredRunIds || runId in runs) {
                errorMessage = "tool call returned a duplicate run id"
              } else {
                runs[runId] = RealtimeAgentRun(callId = callId, session = session)
              }
            } else {
              retireRunLocked(runId)
            }
          } else {
            retireRunLocked(runId)
          }
          RealtimeAgentRunRegistration(
            completion = cached.takeIf { activeSession == session },
            errorMessage = errorMessage,
            unhandled = drainEarlyCompletionsIfIdleLocked(),
          )
        }
      registration.unhandled.forEach(onUnhandledCompletion)
      if (registration.errorMessage != null) {
        submitError(session, callId, registration.errorMessage)
      } else if (registration.completion != null) {
        dispatchCompletion(RealtimeAgentRun(callId = callId, session = session), registration.completion)
      }
    } catch (err: TimeoutCancellationException) {
      val finish = finishPending(pendingCall)
      finish.unhandled.forEach(onUnhandledCompletion)
      if (finish.canSubmitError) submitError(session, callId, "tool call timed out")
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      val message = err.message ?: "tool call failed"
      val finish = finishPending(pendingCall)
      finish.unhandled.forEach(onUnhandledCompletion)
      if (finish.canSubmitError) {
        onError(session, "realtime toolCall failed: $message")
        submitError(session, callId, message)
      }
    }
  }

  private suspend fun runControl(
    session: RealtimeAgentSession,
    callId: String,
    args: JsonElement?,
  ) {
    try {
      val argsObject = args as? JsonObject
      val text =
        argsObject
          ?.get("text")
          .asStringOrNull()
          ?.trim()
          .orEmpty()
      val mode =
        argsObject
          ?.get("mode")
          .asStringOrNull()
          ?.trim()
          ?.takeIf(String::isNotEmpty)
      val params =
        buildJsonObject {
          put("sessionId", JsonPrimitive(session.relaySessionId))
          put("sessionKey", JsonPrimitive(session.sessionKey))
          put("text", JsonPrimitive(text.ifEmpty { "status" }))
          if (mode != null) put("mode", JsonPrimitive(mode))
        }
      val response = requestGateway("talk.session.steer", params.toString(), TOOL_CALL_TIMEOUT_MILLIS)
      val result = runCatching { json.parseToJsonElement(response) as? JsonObject }.getOrNull()
      if (result == null) {
        submitError(session, callId, "control call returned no result")
      } else {
        submitResult(session, callId, result)
      }
    } catch (err: TimeoutCancellationException) {
      submitError(session, callId, "control call timed out")
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      val message = err.message ?: "control call failed"
      onError(session, "realtime control failed: $message")
      submitError(session, callId, message)
    }
  }

  private fun dispatchCompletion(
    run: RealtimeAgentRun,
    completion: RealtimeAgentCompletion,
  ) {
    val scope = synchronized(lock) { sessionScope.takeIf { activeSession == run.session } } ?: return
    scope.launch {
      when (completion.state) {
        "final" -> {
          val text = ChatEventText.assistantTextFromMessage(completion.message).orEmpty()
          submitResult(
            run.session,
            run.callId,
            buildJsonObject { put("text", JsonPrimitive(text)) },
          )
        }
        "aborted", "error" -> submitError(run.session, run.callId, completion.state)
      }
    }
  }

  private fun failOverflowedCalls(calls: List<RealtimeAgentPendingCall>) {
    calls.forEach { it.job?.cancel() }
    calls.forEach { call ->
      val scope = synchronized(lock) { sessionScope.takeIf { activeSession == call.session } } ?: return@forEach
      scope.launch { submitError(call.session, call.callId, "tool completion correlation buffer overflow") }
    }
  }

  private suspend fun submitWorking(
    session: RealtimeAgentSession,
    callId: String,
  ) {
    submitResult(
      session = session,
      callId = callId,
      result =
        buildJsonObject {
          put("status", JsonPrimitive("working"))
          put("tool", JsonPrimitive(AGENT_CONSULT_TOOL))
          put(
            "message",
            JsonPrimitive(
              "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
            ),
          )
        },
      options = buildJsonObject { put("willContinue", JsonPrimitive(true)) },
    )
  }

  private suspend fun submitError(
    session: RealtimeAgentSession,
    callId: String,
    message: String,
  ) {
    submitResult(
      session = session,
      callId = callId,
      result = buildJsonObject { put("error", JsonPrimitive(message)) },
    )
  }

  private suspend fun submitResult(
    session: RealtimeAgentSession,
    callId: String,
    result: JsonObject,
    options: JsonObject? = null,
  ) {
    if (!isActive(session)) return
    val params =
      buildJsonObject {
        put("sessionId", JsonPrimitive(session.relaySessionId))
        put("callId", JsonPrimitive(callId))
        put("result", result)
        if (options != null) put("options", options)
      }
    try {
      requestGateway("talk.session.submitToolResult", params.toString(), TOOL_CALL_TIMEOUT_MILLIS)
    } catch (err: TimeoutCancellationException) {
      onError(session, "realtime submitToolResult timed out")
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      onError(session, "realtime submitToolResult failed: ${err.message ?: err::class.simpleName}")
    }
  }

  private fun parseRunId(payloadJson: String): String? =
    runCatching {
      (json.parseToJsonElement(payloadJson) as? JsonObject)
        ?.get("runId")
        .asStringOrNull()
    }.getOrNull()

  private fun isActive(session: RealtimeAgentSession): Boolean = synchronized(lock) { activeSession == session }

  private fun isPending(call: RealtimeAgentPendingCall): Boolean = synchronized(lock) { isPendingLocked(call) }

  private fun isPendingLocked(call: RealtimeAgentPendingCall): Boolean = call in pendingCalls && !call.failed

  private fun clearSessionLocked(): List<RealtimeAgentUnhandledCompletion> {
    runs.keys.forEach(::retireRunLocked)
    activeSession = null
    sessionScope?.cancel()
    sessionScope = null
    runs.clear()
    return drainEarlyCompletionsIfIdleLocked()
  }

  private fun finishPending(call: RealtimeAgentPendingCall): RealtimeAgentPendingFinish =
    synchronized(lock) {
      val removed = pendingCalls.remove(call)
      RealtimeAgentPendingFinish(
        canSubmitError = removed && !call.failed && activeSession == call.session,
        unhandled = if (removed) drainEarlyCompletionsIfIdleLocked() else emptyList(),
      )
    }

  private fun drainEarlyCompletionsIfIdleLocked(): List<RealtimeAgentUnhandledCompletion> {
    if (pendingCalls.isNotEmpty()) return emptyList()
    return earlyCompletions
      .map { (runId, completion) -> completion.toUnhandled(runId) }
      .also { earlyCompletions.clear() }
  }

  private fun hasPendingCallForSessionLocked(
    sessionKey: String?,
  ): Boolean = pendingCalls.any { !it.failed && (sessionKey == null || it.session.sessionKey == sessionKey) }

  private fun cacheEarlyCompletionLocked(
    runId: String,
    completion: RealtimeAgentCompletion,
  ): RealtimeAgentCacheOverflow? {
    earlyCompletions[runId] = completion
    if (earlyCompletions.size <= maxCachedCompletions) return null
    val unhandled = earlyCompletions.map { (cachedRunId, cached) -> cached.toUnhandled(cachedRunId) }
    val failedCalls = pendingCalls.filterNot { it.failed }
    failedCalls.forEach { it.failed = true }
    earlyCompletions.clear()
    return RealtimeAgentCacheOverflow(unhandled = unhandled, failedCalls = failedCalls)
  }

  private fun retireRunLocked(runId: String) {
    retiredRunIds += runId
    while (retiredRunIds.size > maxCachedCompletions) {
      retiredRunIds.remove(retiredRunIds.first())
    }
  }

  private companion object {
    const val TAG = "RealtimeAgent"
    const val AGENT_CONSULT_TOOL = "openclaw_agent_consult"
    const val AGENT_CONTROL_TOOL = "openclaw_agent_control"
    const val TOOL_CALL_TIMEOUT_MILLIS = 15_000L
    const val MAX_CACHED_COMPLETIONS = 128
    val TERMINAL_STATES = setOf("final", "aborted", "error")
  }
}

private fun RealtimeAgentCompletion.toUnhandled(runId: String) =
  RealtimeAgentUnhandledCompletion(
    sessionKey = sessionKey,
    runId = runId,
    state = state,
    message = message,
  )

private fun JsonElement?.asStringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
