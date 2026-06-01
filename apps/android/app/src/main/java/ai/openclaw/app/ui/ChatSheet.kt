package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ui.chat.ChatSheetContent
import androidx.compose.runtime.Composable

/** Keeps the public shell entry point stable while chat internals live under ui.chat. */
@Composable
fun ChatSheet(viewModel: MainViewModel) {
  ChatSheetContent(viewModel = viewModel)
}
