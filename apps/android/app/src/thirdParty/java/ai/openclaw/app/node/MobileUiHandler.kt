package ai.openclaw.app.node

import ai.openclaw.app.accessibility.AccessibilityActionExecutor
import ai.openclaw.app.accessibility.AccessibilityServiceDisabledException
import ai.openclaw.app.accessibility.ActionResult
import ai.openclaw.app.accessibility.GlobalActionName
import ai.openclaw.app.accessibility.MobileUiAction
import ai.openclaw.app.accessibility.MobileUiSnapshot
import ai.openclaw.app.accessibility.OpenClawAccessibilityService
import ai.openclaw.app.accessibility.ScrollDirection
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

internal data class MobileUiActRequest(
  val snapshotId: String,
  val action: MobileUiAction,
)

/**
 * Flavor-owned bridge from node.invoke to the Android accessibility executor.
 *
 * Observe returns `{snapshotId,capturedAtMs,package,windowTitle,nodes}`. Each node contains
 * `{ref,parentRef,role,text,contentDescription,viewId,bounds:[l,t,r,b],flags,actions}`.
 * Act accepts `{snapshotId,action:{type,...}}` and returns `{code,message}`.
 */
class MobileUiHandler {
  private val executor = AccessibilityActionExecutor()
  private val invokeMutex = Mutex()

  val isConnected: StateFlow<Boolean> = OpenClawAccessibilityService.isConnected

  suspend fun handleObserve(
    @Suppress("UNUSED_PARAMETER") paramsJson: String?,
  ): GatewaySession.InvokeResult =
    invokeMutex.withLock {
      try {
        GatewaySession.InvokeResult.ok(mobileUiSnapshotJson(executor.observe()))
      } catch (error: AccessibilityServiceDisabledException) {
        GatewaySession.InvokeResult.error(
          code = "SERVICE_DISABLED",
          message = "SERVICE_DISABLED: ${error.message ?: "accessibility service is disabled"}",
        )
      } catch (error: CancellationException) {
        throw error
      } catch (error: Throwable) {
        GatewaySession.InvokeResult.error(
          code = "MOBILE_UI_OBSERVE_FAILED",
          message = "MOBILE_UI_OBSERVE_FAILED: ${error.message ?: "snapshot failed"}",
        )
      }
    }

  suspend fun handleAct(paramsJson: String?): GatewaySession.InvokeResult =
    invokeMutex.withLock {
      val request =
        parseMobileUiActRequest(paramsJson)
          ?: return@withLock GatewaySession.InvokeResult.error(
            code = "INVALID_REQUEST",
            message = "INVALID_REQUEST: expected {snapshotId,action:{type,...}}",
          )
      try {
        GatewaySession.InvokeResult.ok(actionResultJson(executor.act(request.snapshotId, request.action)))
      } catch (error: CancellationException) {
        throw error
      } catch (error: Throwable) {
        GatewaySession.InvokeResult.error(
          code = "MOBILE_UI_ACT_FAILED",
          message = "MOBILE_UI_ACT_FAILED: ${error.message ?: "action failed"}",
        )
      }
    }
}

internal fun mobileUiSnapshotJson(snapshot: MobileUiSnapshot): String =
  buildJsonObject {
    put("snapshotId", snapshot.id)
    put("capturedAtMs", snapshot.capturedAtMs)
    put("package", JsonPrimitive(snapshot.packageName))
    put("windowTitle", JsonPrimitive(snapshot.windowTitle))
    put(
      "nodes",
      buildJsonArray {
        snapshot.nodes.forEach { node ->
          add(
            buildJsonObject {
              put("ref", node.ref)
              put("parentRef", JsonPrimitive(node.parentRef))
              put("role", node.role)
              put("text", JsonPrimitive(node.text))
              put("contentDescription", JsonPrimitive(node.contentDescription))
              put("viewId", JsonPrimitive(node.viewId))
              put(
                "bounds",
                buildJsonArray {
                  add(JsonPrimitive(node.boundsInScreen.left))
                  add(JsonPrimitive(node.boundsInScreen.top))
                  add(JsonPrimitive(node.boundsInScreen.right))
                  add(JsonPrimitive(node.boundsInScreen.bottom))
                },
              )
              put(
                "flags",
                buildJsonObject {
                  put("clickable", node.clickable)
                  put("editable", node.editable)
                  put("scrollable", node.scrollable)
                  put("enabled", node.enabled)
                  put("focused", node.focused)
                },
              )
              put(
                "actions",
                buildJsonArray {
                  node.actions.forEach { action -> add(JsonPrimitive(action)) }
                },
              )
            },
          )
        }
      },
    )
  }.toString()

internal fun parseMobileUiActRequest(paramsJson: String?): MobileUiActRequest? {
  val params = parseJsonParamsObject(paramsJson) ?: return null
  val snapshotId = params.requiredString("snapshotId") ?: return null
  val actionParams = params["action"] as? JsonObject ?: return null
  val type = actionParams.requiredString("type") ?: return null
  val action =
    when (type) {
      "activate" -> MobileUiAction.Activate(actionParams.requiredString("ref") ?: return null)
      "set_text" ->
        MobileUiAction.SetText(
          ref = actionParams.requiredString("ref") ?: return null,
          text = actionParams.string("text") ?: return null,
        )
      "scroll" ->
        MobileUiAction.Scroll(
          ref = actionParams.requiredString("ref") ?: return null,
          direction =
            when (actionParams.requiredString("direction")) {
              "forward" -> ScrollDirection.Forward
              "backward" -> ScrollDirection.Backward
              else -> return null
            },
        )
      "tap" ->
        MobileUiAction.Tap(
          x = actionParams.int("x") ?: return null,
          y = actionParams.int("y") ?: return null,
        )
      "swipe" ->
        MobileUiAction.Swipe(
          x1 = actionParams.int("x1") ?: return null,
          y1 = actionParams.int("y1") ?: return null,
          x2 = actionParams.int("x2") ?: return null,
          y2 = actionParams.int("y2") ?: return null,
          durationMs = actionParams.long("durationMs") ?: return null,
        )
      "global_action" ->
        MobileUiAction.GlobalAction(
          when (actionParams.requiredString("name")) {
            "back" -> GlobalActionName.Back
            "home" -> GlobalActionName.Home
            "recents" -> GlobalActionName.Recents
            "notifications" -> GlobalActionName.Notifications
            else -> return null
          },
        )
      "wait" -> MobileUiAction.Wait(actionParams.long("ms") ?: return null)
      else -> return null
    }
  return MobileUiActRequest(snapshotId = snapshotId, action = action)
}

private fun actionResultJson(result: ActionResult): String =
  buildJsonObject {
    put("code", result.code.value)
    put("message", JsonPrimitive(result.message))
  }.toString()

private fun JsonObject.string(key: String): String? =
  (this[key] as? JsonPrimitive)
    ?.takeIf { it.isString }
    ?.contentOrNull

private fun JsonObject.requiredString(key: String): String? = string(key)?.takeIf(String::isNotBlank)

private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.contentOrNull?.toIntOrNull()

private fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.contentOrNull?.toLongOrNull()
