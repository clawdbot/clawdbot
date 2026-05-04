import Commander
import Foundation
import Speech
import Swabble

@MainActor
struct DoctorCommand: ParsableCommand {
    static var commandDescription: CommandDescription {
        CommandDescription(commandName: "doctor", abstract: "Check Speech permission and config")
    }

    @Option(name: .long("config"), help: "Path to config JSON") var configPath: String?

    init() {}
    init(parsed: ParsedValues) {
        self.init()
        if let cfg = parsed.options["config"]?.last { configPath = cfg }
    }

    mutating func run() async throws {
        let auth = await SFSpeechRecognizer.authorizationStatus()
        print("Speech auth: \(auth)")
        do {
            _ = try ConfigLoader.load(at: configURL)
            print("Config: OK")
        } catch {
            print("Config missing or invalid; run setup")
        }
        let session = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external],
            mediaType: .audio,
            position: .unspecified)
        print("Mics found: \(session.devices.count)")
    }

    private var configURL: URL? { configPath.map { URL(fileURLWithPath: $0) } }
}
