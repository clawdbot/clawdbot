import Foundation

struct ChatStreamingRevealState: Equatable {
    struct Word: Equatable {
        let characterRange: Range<Int>
        let fadeStart: TimeInterval
        let deadline: TimeInterval
    }

    var text: String
    var words: [Word]

    init(text: String = "", words: [Word] = []) {
        self.text = text
        self.words = words
    }

    var latestDeadline: TimeInterval? {
        self.words.map(\.deadline).max()
    }
}

struct ChatStreamingRevealFrame: Equatable {
    struct FadingWord: Equatable {
        let characterRange: Range<Int>
        let opacity: Double
    }

    let fullyRevealedPrefixCharacterOffset: Int
    let fading: [FadingWord]
}

private enum ChatStreamingRevealConstants {
    static let wordInterval: TimeInterval = 0.04
    static let fadeDuration: TimeInterval = 0.12
    static let maximumCatchUpDuration: TimeInterval = 0.4
    static let maximumFadingWords = 24
}

func step(
    state: ChatStreamingRevealState,
    newText: String,
    now: TimeInterval) -> ChatStreamingRevealState
{
    guard newText.hasPrefix(state.text) else {
        // Rewrites are uncommon and can invalidate every old character range.
        // Reveal the replacement immediately; later appends start a new pace.
        return ChatStreamingRevealState(text: newText)
    }
    guard newText != state.text else {
        return ChatStreamingRevealState(
            text: newText,
            words: state.words.filter { $0.deadline > now })
    }

    let oldCharacterCount = state.text.count
    let ranges = chatStreamingWordRanges(in: newText)
    let rangesByStart = Dictionary(uniqueKeysWithValues: ranges.map { ($0.lowerBound, $0) })

    var words = state.words.compactMap { word -> ChatStreamingRevealState.Word? in
        guard word.deadline > now,
              let updatedRange = rangesByStart[word.characterRange.lowerBound]
        else { return nil }
        return ChatStreamingRevealState.Word(
            characterRange: updatedRange,
            fadeStart: word.fadeStart,
            deadline: word.deadline)
    }

    let trackedStarts = Set(words.map(\.characterRange.lowerBound))
    let appendedRanges = ranges.filter {
        $0.lowerBound >= oldCharacterCount && !trackedStarts.contains($0.lowerBound)
    }
    words.append(contentsOf: appendedRanges.map {
        ChatStreamingRevealState.Word(
            characterRange: $0,
            fadeStart: now,
            deadline: now + ChatStreamingRevealConstants.fadeDuration)
    })
    words.sort { $0.characterRange.lowerBound < $1.characterRange.lowerBound }

    if words.count > ChatStreamingRevealConstants.maximumFadingWords {
        words.removeFirst(words.count - ChatStreamingRevealConstants.maximumFadingWords)
    }

    let spacing: TimeInterval
    if words.count > 1 {
        let catchUpSpacing =
            (ChatStreamingRevealConstants.maximumCatchUpDuration - ChatStreamingRevealConstants.fadeDuration)
            / Double(words.count - 1)
        spacing = min(ChatStreamingRevealConstants.wordInterval, catchUpSpacing)
    } else {
        spacing = 0
    }

    words = words.enumerated().map { index, word in
        let scheduledStart = now + Double(index) * spacing
        let scheduledDeadline = scheduledStart + ChatStreamingRevealConstants.fadeDuration
        let isExistingWord = trackedStarts.contains(word.characterRange.lowerBound)
        return ChatStreamingRevealState.Word(
            characterRange: word.characterRange,
            fadeStart: isExistingWord ? word.fadeStart : scheduledStart,
            // Catch-up may move an existing deadline earlier, never later. That
            // preserves or increases its current opacity across append steps.
            deadline: isExistingWord ? min(word.deadline, scheduledDeadline) : scheduledDeadline)
    }

    return ChatStreamingRevealState(text: newText, words: words)
}

func revealedOpacities(
    state: ChatStreamingRevealState,
    now: TimeInterval) -> ChatStreamingRevealFrame
{
    let fading = state.words.compactMap { word -> ChatStreamingRevealFrame.FadingWord? in
        guard now < word.deadline else { return nil }
        let duration = word.deadline - word.fadeStart
        let opacity = duration > 0
            ? min(1, max(0, (now - word.fadeStart) / duration))
            : 1
        return ChatStreamingRevealFrame.FadingWord(
            characterRange: word.characterRange,
            opacity: opacity)
    }
    return ChatStreamingRevealFrame(
        fullyRevealedPrefixCharacterOffset: fading.first?.characterRange.lowerBound ?? state.text.count,
        fading: fading)
}

func chatStreamingWordRanges(in text: String) -> [Range<Int>] {
    var ranges: [Range<Int>] = []
    var wordStart: Int?

    for (offset, character) in text.enumerated() {
        if character.isWhitespace {
            if let start = wordStart {
                ranges.append(start..<offset)
                wordStart = nil
            }
        } else if wordStart == nil {
            wordStart = offset
        }
    }
    if let wordStart {
        ranges.append(wordStart..<text.count)
    }
    return ranges
}
