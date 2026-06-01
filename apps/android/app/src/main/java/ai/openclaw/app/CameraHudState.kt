package ai.openclaw.app

/** Camera HUD state categories shown over the Android UI during capture. */
enum class CameraHudKind {
  Photo,
  Recording,
  Success,
  Error,
}

/** One-shot camera HUD message keyed by token so repeated text still replays. */
data class CameraHudState(
  val token: Long,
  val kind: CameraHudKind,
  val message: String,
)
