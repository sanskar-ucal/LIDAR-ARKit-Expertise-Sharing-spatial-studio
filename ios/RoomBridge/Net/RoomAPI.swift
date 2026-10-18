import Foundation
import RoomBridgeCore

struct APIError: LocalizedError {
    var code: String
    var message: String
    var errorDescription: String? { message }
}

/// HTTP endpoints: room creation and the chunked, atomically committed scan upload.
struct RoomAPI {
    let base: URL

    /// Validates a user-entered server URL and explains the common iPhone mistakes.
    static func parseServerURL(_ text: String) throws -> URL {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme), let host = url.host, !host.isEmpty else {
            throw APIError(code: "bad_url", message: "Enter the server address, e.g. http://10.0.0.61:8787")
        }
        if host == "localhost" || host == "127.0.0.1" {
            throw APIError(code: "localhost", message: "On an iPhone, “localhost” is the phone itself. Use your Mac’s Wi-Fi IP address, e.g. http://10.0.0.61:8787.")
        }
        return url
    }

    var webSocketBase: URL {
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        c.scheme = base.scheme == "https" ? "wss" : "ws"
        c.path = ""
        return c.url!
    }

    private func check(_ data: Data, _ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw APIError(code: "network", message: "No response") }
        guard (200..<300).contains(http.statusCode) else {
            struct Body: Decodable { struct E: Decodable { var code: String; var message: String }; var error: E }
            if let b = try? JSONDecoder().decode(Body.self, from: data) { throw APIError(code: b.error.code, message: b.error.message) }
            throw APIError(code: "http_\(http.statusCode)", message: "Server returned HTTP \(http.statusCode)")
        }
    }

    func createRoom(hostName: String) async throws -> CreatedRoom {
        var req = URLRequest(url: base.appendingPathComponent("api/rooms"))
        req.httpMethod = "POST"
        req.timeoutInterval = 10
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONEncoder().encode(["hostName": hostName])
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(data, resp)
        return try JSONDecoder().decode(CreatedRoom.self, from: data)
    }

    func uploadScan(roomId: String, hostToken: String, epoch: Int, scan: Data, vertexCount: Int, triangleCount: Int,
                    synthetic: Bool, progress: @escaping @MainActor (Double) -> Void) async throws -> ScanMeta {
        let chunks = ScanEncoding.chunks(scan)
        let root = base.appendingPathComponent("api/rooms/\(roomId)/scan")
        func request(_ url: URL, method: String, body: Data?, json: Bool) -> URLRequest {
            var r = URLRequest(url: url)
            r.httpMethod = method
            r.timeoutInterval = 20
            r.setValue("Bearer \(hostToken)", forHTTPHeaderField: "authorization")
            r.setValue(json ? "application/json" : "application/octet-stream", forHTTPHeaderField: "content-type")
            r.httpBody = body
            return r
        }
        struct Begin: Encodable { var originEpoch, chunkCount, totalBytes, vertexCount, triangleCount: Int; var synthetic: Bool }
        struct BeginResp: Decodable { var uploadId: String }
        struct CommitResp: Decodable { var scan: ScanMeta }
        let beginBody = try JSONEncoder().encode(Begin(originEpoch: epoch, chunkCount: chunks.count, totalBytes: scan.count,
                                                       vertexCount: vertexCount, triangleCount: triangleCount, synthetic: synthetic))
        let (bd, br) = try await URLSession.shared.data(for: request(root.appendingPathComponent("begin"), method: "POST", body: beginBody, json: true))
        try check(bd, br)
        let uploadId = try JSONDecoder().decode(BeginResp.self, from: bd).uploadId
        for (i, chunk) in chunks.enumerated() {
            let url = root.appendingPathComponent("\(uploadId)/chunks/\(i)")
            let (d, r) = try await URLSession.shared.data(for: request(url, method: "PUT", body: chunk, json: false))
            try check(d, r)
            await progress(Double(i + 1) / Double(chunks.count + 1))
        }
        let (cd, cr) = try await URLSession.shared.data(for: request(root.appendingPathComponent("\(uploadId)/commit"), method: "POST", body: nil, json: true))
        try check(cd, cr)
        await progress(1)
        return try JSONDecoder().decode(CommitResp.self, from: cd).scan
    }

    /// Uploads a push-to-talk clip; attach the returned id to a comment.add.
    func uploadVoice(roomId: String, token: String, audio: Data, mime: String) async throws -> String {
        var req = URLRequest(url: base.appendingPathComponent("api/rooms/\(roomId)/voice"))
        req.httpMethod = "POST"
        req.timeoutInterval = 20
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        req.setValue(mime, forHTTPHeaderField: "content-type")
        req.httpBody = audio
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(data, resp)
        struct Resp: Decodable { var clipId: String }
        return try JSONDecoder().decode(Resp.self, from: data).clipId
    }

    func downloadVoice(roomId: String, token: String, clipId: String) async throws -> Data {
        var req = URLRequest(url: base.appendingPathComponent("api/rooms/\(roomId)/voice/\(clipId)"))
        req.timeoutInterval = 20
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(data, resp)
        return data
    }
}
