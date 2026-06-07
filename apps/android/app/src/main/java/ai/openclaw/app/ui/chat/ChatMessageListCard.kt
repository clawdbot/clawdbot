package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.ui.mobileBorder
import ai.openclaw.app.ui.mobileCallout
import ai.openclaw.app.ui.mobileCardSurface
import ai.openclaw.app.ui.mobileHeadline
import ai.openclaw.app.ui.mobileText
import ai.openclaw.app.ui.mobileTextSecondary
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** Renders chat history newest-first while preserving stable scroll behavior during streaming. */
@Composable
fun ChatMessageListCard(
  messages: List<ChatMessage>,
  historyLoading: Boolean,
  pendingRunCount: Int,
  pendingToolCalls: List<ChatPendingToolCall>,
  streamingAssistantText: String?,
  healthOk: Boolean,
  modifier: Modifier = Modifier,
) {
  val listState = rememberLazyListState()
  val timeline =
    remember(messages, pendingRunCount, pendingToolCalls, streamingAssistantText) {
      buildChatTimeline(
        messages = messages,
        pendingRunCount = pendingRunCount,
        pendingToolCalls = pendingToolCalls,
        streamingAssistantText = streamingAssistantText,
      )
    }

  LaunchedEffect(timeline.scrollTargetIndex, timeline.items.size, pendingRunCount, pendingToolCalls.size) {
    timeline.scrollTargetIndex?.let { index ->
      listState.animateScrollToItem(index = index)
    }
  }

  Box(modifier = modifier.fillMaxWidth()) {
    LazyColumn(
      modifier = Modifier.fillMaxSize(),
      state = listState,
      reverseLayout = true,
      verticalArrangement = Arrangement.spacedBy(10.dp),
      contentPadding =
        androidx.compose.foundation.layout
          .PaddingValues(bottom = 8.dp),
    ) {
      itemsIndexed(items = timeline.items, key = { _, item -> chatTimelineItemKey(item) }) { _, item ->
        when (item) {
          is ChatTimelineItem.Message -> ChatMessageBubble(message = item.message)
          is ChatTimelineItem.PendingTools -> ChatPendingToolsBubble(toolCalls = item.toolCalls)
          is ChatTimelineItem.StreamingAssistant -> ChatStreamingAssistantBubble(text = item.text)
          ChatTimelineItem.Thinking -> ChatTypingIndicatorBubble()
        }
      }
    }

    if (timeline.items.isEmpty()) {
      if (historyLoading) {
        LoadingChatHint(modifier = Modifier.align(Alignment.Center))
      } else {
        EmptyChatHint(modifier = Modifier.align(Alignment.Center), healthOk = healthOk)
      }
    }
  }
}

@Composable
private fun LoadingChatHint(modifier: Modifier = Modifier) {
  Surface(
    modifier = modifier.fillMaxWidth(),
    shape = RoundedCornerShape(14.dp),
    color = mobileCardSurface.copy(alpha = 0.9f),
    border = androidx.compose.foundation.BorderStroke(1.dp, mobileBorder),
  ) {
    Column(
      modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      CircularProgressIndicator(color = mobileText, strokeWidth = 2.dp)
      Text("Loading session", style = mobileCallout, color = mobileTextSecondary)
    }
  }
}

@Composable
private fun EmptyChatHint(
  modifier: Modifier = Modifier,
  healthOk: Boolean,
) {
  Surface(
    modifier = modifier.fillMaxWidth(),
    shape = RoundedCornerShape(14.dp),
    color = mobileCardSurface.copy(alpha = 0.9f),
    border = androidx.compose.foundation.BorderStroke(1.dp, mobileBorder),
  ) {
    androidx.compose.foundation.layout.Column(
      modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
      verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      Text("No messages yet", style = mobileHeadline, color = mobileText)
      Text(
        text =
          if (healthOk) {
            "Send the first prompt to start this session."
          } else {
            "Connect gateway first, then return to chat."
          },
        style = mobileCallout,
        color = mobileTextSecondary,
      )
    }
  }
}
