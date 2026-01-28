package bot.molt.android.ui

import androidx.compose.runtime.Composable
import bot.molt.android.MainViewModel
import bot.molt.android.ui.chat.ChatSheetContent

@Composable
fun ChatSheet(viewModel: MainViewModel) {
  ChatSheetContent(viewModel = viewModel)
}
