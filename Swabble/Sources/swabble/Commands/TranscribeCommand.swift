import AVFoundation
import Commander
import Foundation
import Speech
import Swabble

@MainActor
@available(macOS 26.0, *)
struct TranscribeCommand: ParsableCommand {
    @Argument(help: "Path to audio/video file") var inputFile: String = ""
    @Option(name: .long("locale"), help: "Locale identifier", parsing: .singleValue) var locale: String = Locale.current
        .identifier
    @Flag(help: "Censor etiquette-sensitive content") var censor: Bool = false
    @Option(name: .long("output"), help: "Output file path") var outputFile: String?
    @Option(name: .long("format"), help: "Output format txt|srt") var format: String = "txt"
    @Option(name: .long("max-length"), help: "Max sentence length for srt") var maxLength: Int = 40

    static var commandDescription: CommandDescription {
        CommandDescription(
            commandName: "transcribe",
            abstract: "Transcribe a media file locally")
    }

    init() {}

    init(parsed: ParsedValues) {
        self.init()
        if let positional = parsed.positional.first { inputFile = positional }
        if let loc = parsed.options["locale"]?.last { locale = loc }
        if parsed.flags.contains("censor") { censor = true }
        if let out = parsed.options["output"]?.last { outputFile = out }
        if let fmt = parsed.options["format"]?.last { format = fmt }
        if let len = parsed.options["maxLength"]?.last, let intVal = Int(len) { maxLength = intVal }
    }

    mutating func run() async throws {
        let fileURL = URL(fileURLWithPath: inputFile)
        let audioFile = try AVAudioFile(forReading: fileURL)

        let outputFormat = OutputFormat(rawValue: format) ?? .txt

        let transcriber = SpeechTranscriber(
            locale: Locale(identifier: locale),
            transcriptionOptions: censor ? [.etiquetteReplacements] : [],
            reportingOptions: [],
            attributeOptions: outputFormat.needsAudioTimeRange ? [.audioTimeRange] : [])
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        try await analyzer.start(inputAudioFile: audioFile, finishAfterFile: true)

        var transcript: AttributedString = ""
        for try await result in transcriber.results {
            transcript += result.text
        }

        let output = outputFormat.text(for: transcript, maxLength: maxLength)
        if let path = outputFile {
            try output.write(to: URL(fileURLWithPath: path), atomically: false, encoding: .utf8)
        } else {
            print(output)
        }
    }
}
