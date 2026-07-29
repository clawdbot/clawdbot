import Foundation

extension PropertyAPIClient {
    func fetchAssets() async throws -> [RanchAsset] {
        let url = try makeURL("/assets")
        let (data, response) = try await URLSession.shared.data(from: url)
        try validate(response, data: data)
        return try decoder.decode([RanchAsset].self, from: data)
    }

    func fetchAsset(id: UUID) async throws -> RanchAsset {
        let url = try makeURL("/assets/\(id.uuidString)")
        let (data, response) = try await URLSession.shared.data(from: url)
        try validate(response, data: data)
        return try decoder.decode(RanchAsset.self, from: data)
    }

    func fetchAssetByQR(token: String) async throws -> RanchAsset {
        let url = try makeURL("/assets/by-qr/\(token)")
        let (data, response) = try await URLSession.shared.data(from: url)
        try validate(response, data: data)
        return try decoder.decode(RanchAsset.self, from: data)
    }

    func fetchMeterReadings(assetId: UUID, limit: Int = 50) async throws -> [MeterReading] {
        let url = try makeURL("/assets/\(assetId.uuidString)/meter-readings?limit=\(limit)")
        let (data, response) = try await URLSession.shared.data(from: url)
        try validate(response, data: data)
        return try decoder.decode([MeterReading].self, from: data)
    }

    func submitMeterReading(
        assetId: UUID,
        value: Double,
        note: String?,
        entryMethod: String = "manual",
        correctionReason: String? = nil
    ) async throws -> RanchAsset {
        let url = try makeURL("/assets/\(assetId.uuidString)/meter-readings")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["value": value, "entry_method": entryMethod]
        if let note, !note.isEmpty { body["note"] = note }
        if let correctionReason { body["correction_reason"] = correctionReason }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 409 {
            let conflict = try? JSONDecoder().decode(LowerReadingError.self, from: data)
            throw PropertyAPIError.serverMessage(conflict?.error ?? "lower_reading")
        }
        try validate(response, data: data)
        return try decoder.decode(RanchAsset.self, from: data)
    }

    func parseMeterText(_ text: String) async throws -> MeterParseResult {
        let url = try makeURL("/meter-readings/parse")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["text": text])
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
        return try JSONDecoder().decode(MeterParseResult.self, from: data)
    }
}
