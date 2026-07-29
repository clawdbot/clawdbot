import Foundation

enum PropertyAPIError: LocalizedError {
    case invalidURL
    case serverMessage(String)
    case lowerReadingConfirmation(LowerReadingPreview)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid API URL."
        case .serverMessage(let message):
            return message
        case .lowerReadingConfirmation:
            return "Reading is lower than current. Confirmation required."
        }
    }
}

/// Shared HTTP client for PropertyManager REST API.
/// Asset/meter endpoints use `/v1/`; task endpoints remain at root (Phase 1 API).
final class PropertyAPIClient {
    let baseURLString: String
    var apiKey: String?
    var operatorPIN: String?
    var operatorIdentity: String?

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    init(baseURLString: String, apiKey: String? = nil, operatorPIN: String? = nil, operatorIdentity: String? = nil) {
        self.baseURLString = baseURLString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        self.apiKey = apiKey
        self.operatorPIN = operatorPIN
        self.operatorIdentity = operatorIdentity
    }

    func makeURL(_ path: String, versioned: Bool = false) throws -> URL {
        let prefix = versioned ? "/v1" : ""
        let normalized = path.hasPrefix("/") ? path : "/\(path)"
        guard let url = URL(string: baseURLString + prefix + normalized) else {
            throw PropertyAPIError.invalidURL
        }
        return url
    }

    func applyAuth(to request: inout URLRequest) {
        if let apiKey, !apiKey.isEmpty {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        } else if let operatorPIN, !operatorPIN.isEmpty {
            request.setValue(operatorPIN, forHTTPHeaderField: "X-Operator-PIN")
        }
        if let operatorIdentity, !operatorIdentity.isEmpty {
            request.setValue(operatorIdentity, forHTTPHeaderField: "X-Operator-Identity")
        }
    }

    func validate(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200 ... 299).contains(http.statusCode) else {
            if let err = try? JSONDecoder().decode(APIErrorBody.self, from: data) {
                throw PropertyAPIError.serverMessage(err.message ?? err.code ?? "HTTP \(http.statusCode)")
            }
            throw PropertyAPIError.serverMessage("HTTP \(http.statusCode)")
        }
    }

    // MARK: - Categories

    func fetchCategories() async throws -> [MaintenanceCategory] {
        let url = try makeURL("/categories")
        let (data, response) = try await URLSession.shared.data(from: url)
        try validate(response, data: data)
        return try decoder.decode([MaintenanceCategory].self, from: data)
    }

    // MARK: - Tasks

    func fetchTasks() async throws -> [MaintenanceTask] {
        let url = try makeURL("/tasks")
        let (data, response) = try await URLSession.shared.data(from: url)
        try validate(response, data: data)
        return try decoder.decode([MaintenanceTask].self, from: data)
    }

    func updateTask(id: UUID, fields: [String: Any]) async throws -> MaintenanceTask {
        let url = try makeURL("/tasks/\(id.uuidString)")
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(to: &request)
        request.httpBody = try JSONSerialization.data(withJSONObject: fields)
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(MaintenanceTask.self, from: data)
    }

    func replaceParts(taskID: UUID, parts: [[String: Any]]) async throws -> MaintenanceTask {
        let url = try makeURL("/tasks/\(taskID.uuidString)/parts")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(to: &request)
        request.httpBody = try JSONSerialization.data(withJSONObject: ["parts": parts])
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(MaintenanceTask.self, from: data)
    }

    func deleteTask(id: UUID) async throws {
        let url = try makeURL("/tasks/\(id.uuidString)")
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        applyAuth(to: &request)
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
    }

    func completeTask(
        id: UUID,
        note: String?,
        meterValueAtCompletion: Double? = nil,
        confirmCurrentMeter: Bool = false
    ) async throws -> MaintenanceTask {
        let url = try makeURL("/tasks/\(id.uuidString)/complete")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(to: &request)
        var body: [String: Any] = ["note": note ?? ""]
        if let meterValueAtCompletion {
            body["meter_value_at_completion"] = meterValueAtCompletion
        } else if confirmCurrentMeter {
            body["confirm_current_meter"] = true
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(MaintenanceTask.self, from: data)
    }
}

struct APIErrorBody: Codable {
    var code: String?
    var message: String?
    var field: String?
}
