import XCTest
@testable import EACore

final class SampleHubTests: XCTestCase {
    private func day(_ s: String) -> Date { SampleTransport.dayDate(s)! }

    func testDatesMoveToTodayButBirthdaysStay() {
        let body = #"{"start":"2026-11-06T15:00:00.000Z","due":"2026-11-09","birthday":"1991-11-15","text":"Spotify on 2026-11-09"}"#
        let out = SampleTransport.shift(body, days: 10, around: "2026-11-06")
        XCTAssertTrue(out.contains(#""start":"2026-11-16T15:00:00.000Z""#), out)
        XCTAssertTrue(out.contains(#""due":"2026-11-19""#))
        XCTAssertTrue(out.contains(#""birthday":"1991-11-15""#), "a birthday decades ago is not moved")
        XCTAssertTrue(out.contains("Spotify on 2026-11-19"))
        XCTAssertEqual(SampleTransport.shift(body, days: 0, around: "2026-11-06"), body)
    }

    func testARequestForTodayFindsTheRecordingsToday() async throws {
        let recKey = SampleTransport.key(method: "GET", path: "planner/day/2026-11-06", query: ["tz": "America/New_York"], recordedDay: "2026-11-06")
        XCTAssertEqual(recKey, "GET planner/day/@D+0?tz=America/New_York")
        let rec = SampleTransport.Recording(day: "2026-11-06", entries: [recKey: .init(status: 200, body: #"{"date":"2026-11-06"}"#)])
        let t = SampleTransport(recording: rec, today: day("2026-12-01"))
        let r = try await t.send(method: "GET", path: "planner/day/2026-12-01", query: ["tz": "America/New_York"], body: nil)
        XCTAssertEqual(r.status, 200)
        XCTAssertEqual(String(data: r.data, encoding: .utf8), #"{"date":"2026-12-01"}"#)
    }

    func testEditsStayOnTheDeviceAndTheAssistantSaysWhy() async throws {
        let t = SampleTransport(recording: .init(day: "2026-11-06"), today: day("2026-11-06"))
        let push = try JSONEncoder().encode(PushRequest(device_id: "sample-device", patches: [Patch(id: "a1", kind: .task, fields: ["title": "x"], create: true)]))
        let p = try await t.send(method: "POST", path: "sync/push", query: [:], body: push)
        let pr = try JSONDecoder().decode(PushResponse.self, from: p.data)
        XCTAssertEqual(pr.applied.map(\.id), ["a1"])
        let c = try await t.send(method: "POST", path: "ai/chat", query: [:], body: Data("{}".utf8))
        XCTAssertTrue(try JSONDecoder().decode(ChatResponse.self, from: c.data).reply.contains("sample data"))
        let req = try JSONEncoder().encode(ChatRequest(session_id: "s1", message: "What's on today?"))
        _ = try await t.send(method: "POST", path: "ai/chat", query: [:], body: req)
        let back = try JSONDecoder().decode(AISession.self, from: try await t.send(method: "GET", path: "ai/sessions/s1", query: [:], body: nil).data)
        XCTAssertEqual(back.messages.map(\.role), [.user, .assistant], "the screen reads the conversation back")
        let later = try await t.send(method: "GET", path: "sync/changes", query: ["since": "1000001"], body: nil)
        XCTAssertEqual(try JSONDecoder().decode(ChangesResponse.self, from: later.data).changes.count, 0)
        let other = try await t.send(method: "POST", path: "capture", query: [:], body: Data("{}".utf8))
        XCTAssertEqual(other.status, 503)
    }

    /// The recording the app ships answers every read the screens make (SampleScreens), on each day of the week: Week
    /// asks for this week's Monday, which is a different distance from today on each weekday.
    func testTheBundledRecordingAnswersEveryScreenOnEveryWeekday() async throws {
        let rec = try JSONDecoder().decode(SampleTransport.Recording.self, from: Data(contentsOf: SampleScreens.bundledRecording))
        let recorded = try XCTUnwrap(SampleTransport.dayDate(rec.day))
        var weekdays = Set<Int>()
        for k in 0..<7 {
            // A month after the recording, so every date in the answers moves.
            let today = try XCTUnwrap(Calendar.current.date(byAdding: .day, value: 30 + k, to: recorded))
            weekdays.insert(Calendar.current.component(.weekday, from: today))
            let client = HubClient(transport: SampleTransport(recording: rec, today: today))
            let world = try await SampleScreens.World.load(client)
            XCTAssertFalse(world.entities.isEmpty)
            var missed: [String] = []
            for read in SampleScreens.reads(world, today: today) {
                do { try await read.call(client) } catch { missed.append("\(read.screen): \(error.localizedDescription)") }
            }
            XCTAssertEqual(missed, [], "not answered on \(LocalPlanner.dateString(today))")
        }
        XCTAssertEqual(weekdays.count, 7)
    }

    /// Week's answer on a later day is the week that starts on that day's Monday, with the recorded days moved there.
    func testTheWeekShownStartsOnThisWeeksMonday() async throws {
        let rec = try JSONDecoder().decode(SampleTransport.Recording.self, from: Data(contentsOf: SampleScreens.bundledRecording))
        let recorded = try XCTUnwrap(SampleTransport.dayDate(rec.day))
        for k in 40..<47 {
            let today = try XCTUnwrap(Calendar.current.date(byAdding: .day, value: k, to: recorded))
            let client = HubClient(transport: SampleTransport(recording: rec, today: today))
            let monday = LocalPlanner.dateString(LocalPlanner.monday(of: today))
            let week = try await client.plannerWeek(start: monday, minHours: LocalPlanner.defaultBlockHours)
            XCTAssertEqual(week.start, monday)
            XCTAssertEqual(week.days.count, 7)
            XCTAssertTrue(week.days.contains { $0.date == LocalPlanner.dateString(today) }, "today is in this week on \(LocalPlanner.dateString(today))")
        }
    }

    /// Sample mode as the app starts it: the month syncs with no error, and Today and Week (this week, the ones either
    /// side) come from the recording, not from the plan the device works out when the hub has no answer.
    @MainActor
    func testSampleModeSyncsAndPlansFromTheRecording() async throws {
        let before = SampleTransport.shared
        defer { SampleTransport.shared = before }
        SampleTransport.shared = SampleTransport(data: try Data(contentsOf: SampleScreens.bundledRecording))
        XCTAssertNotNil(SampleTransport.shared)
        let engine = SyncEngine(config: SharedConfig(suiteName: "sample-engine-\(UUID().uuidString)"), platform: .iphone, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        await engine.startSample()
        XCTAssertNil(engine.lastError)
        XCTAssertFalse(engine.list(.task).isEmpty)
        let today = await engine.loadToday()
        XCTAssertTrue(today.fromHub)
        let monday = LocalPlanner.monday(of: Date())
        for k in [-7, 0, 7] {
            let start = try XCTUnwrap(Calendar.current.date(byAdding: .day, value: k, to: monday))
            let week = await engine.loadWeek(start: start)
            XCTAssertTrue(week.fromHub, "week of \(LocalPlanner.dateString(start))")
        }
        engine.stop()
    }

    /// The bundled recording is Alex's made-up month and nothing of the machine it was recorded on, and stays small.
    func testTheBundledRecordingHoldsNothingOfTheRecordingMachine() throws {
        let data = try Data(contentsOf: SampleScreens.bundledRecording)
        XCTAssertLessThan(data.count, 2_000_000)
        let rec = try JSONDecoder().decode(SampleTransport.Recording.self, from: data)
        XCTAssertEqual(SampleRecordingCleaner.leftovers(rec), [])
        XCTAssertFalse(rec.entries.keys.contains { $0.hasPrefix("GET ai/sessions") }, "chats are kept on the device in sample mode")
    }

    /// A read the sample has no answer for, and a write it cannot keep, say so in words people read, with no code.
    func testWhatTheSampleCannotAnswerIsWordedWithoutACode() async throws {
        let client = HubClient(transport: SampleTransport(recording: .init(day: "2026-11-06"), today: day("2026-11-06")))
        do {
            _ = try await client.wikiSearch("dragons")
            XCTFail("nothing is recorded")
        } catch let h as HubError {
            XCTAssertEqual(h, .http(status: 404, message: SampleTransport.noSampleData), "screens that treat a 404 as missing still can")
            XCTAssertEqual(h.errorDescription, "This has no sample data. Connect your own hub to see it.")
        }
        do {
            _ = try await client.setWorkSpace(enabled: true)
            XCTFail("a write is refused")
        } catch let h as HubError {
            XCTAssertEqual(h.errorDescription, "This is sample data: connect your own hub to save this.")
        }
        XCTAssertEqual(HubError.http(status: 404, message: "not found").errorDescription, "HTTP 404: not found", "a real hub's refusal keeps its code")
    }

    func testTheRecorderLeavesChatsToTheDevice() async throws {
        struct Hub: HubTransport {
            func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
                (200, Data(path == "ai/sessions" ? #"{"sessions":[]}"#.utf8 : #"{"ok":true}"#.utf8))
            }
        }
        let r = RecordingTransport(inner: Hub(), file: nil, day: "2026-11-06")
        _ = try await r.send(method: "GET", path: "ai/sessions", query: ["limit": "100"], body: nil)
        _ = try await r.send(method: "GET", path: "profile", query: [:], body: nil)
        XCTAssertEqual(Array(r.recording.entries.keys), ["GET profile"])
    }

    func testSampleModeIsConfiguredAndUsesNoNetwork() {
        let c = SharedConfig(suiteName: "sample-test-\(UUID().uuidString)")
        XCTAssertFalse(c.isConfigured)
        c.sampleMode = true
        XCTAssertTrue(c.isConfigured)
        SampleTransport.shared = SampleTransport(recording: .init(day: "2026-11-06"))
        let client = HubClient.make(config: c)
        XCTAssertNotNil(client)
        XCTAssertFalse(client!.supportsStreaming, "no HTTP transport in sample mode")
    }

    /// "Use my location" in the bill splitter: sample mode answers as a hub would (the hub's answers for these places,
    /// from hub/src/mealstax.ts), on the device.
    func testSampleModeFindsTheMealsTaxOnTheDeviceAsTheHubDoes() async throws {
        var u = SampleScreens.bundledRecording
        u.deleteLastPathComponent()
        let table = try JSONDecoder().decode(MealsTaxTable.self, from: Data(contentsOf: u.appendingPathComponent("SampleMealsTax.json")))
        let hub: [(Double, Double, String?, Double)] = [
            (37.32, -122.03, "CA", 7.25), (42.36, -71.06, "MA", 6.25), (39.74, -104.99, "CO", 2.9), (38.9, -77.04, "DC", 10),
            (51.51, -0.13, nil, 0), (21.31, -157.86, "HI", 4), (61.22, -149.9, "AK", 0), (39.1, -94.58, "MO", 4.225), (39.11, -94.63, "KS", 6.5),
        ]
        for (lat, lon, state, pct) in hub {
            let m = table.answer(latitude: lat, longitude: lon)
            XCTAssertEqual(m?.state, state, "\(lat), \(lon)")
            if let m { XCTAssertEqual(m.pct, pct, "\(lat), \(lon)") }
        }

        // Through the client, as the calculator asks.
        let t = SampleTransport(recording: .init(day: "2026-11-06"), today: day("2026-11-06"), mealsTax: table)
        let client = HubClient(transport: t)
        let ca = try await client.mealsTax(latitude: 37.3229, longitude: -122.0322)
        XCTAssertEqual(ca, MealsTax(state: "CA", name: "California", pct: 7.25, note: "California's rate on restaurant meals. Your city or county may add its own."))
        do {
            _ = try await client.mealsTax(latitude: 51.5072, longitude: -0.1276)
            XCTFail("London is not in a US state")
        } catch HubError.http(let status, _) {
            XCTAssertEqual(status, 404, "the calculator says the place is not in a US state")
        }
    }

    func testCalendarRemindersAndContactsWaitForTheHubsWord() {
        let c = SharedConfig(suiteName: "modules-test-\(UUID().uuidString)")
        XCTAssertTrue(c.moduleOn(.appleCalendar), "screens show before the list comes")
        XCTAssertFalse(c.moduleSaidOn(.appleCalendar), "nothing of the person's is copied before the hub says so")
        c.modules = [ModuleInfo(id: "apple_calendar", title: "Apple Calendar", summary: "", group: "On your devices", on: true)]
        XCTAssertTrue(c.moduleSaidOn(.appleCalendar))
        XCTAssertFalse(c.moduleSaidOn(.contacts), "a module the hub did not list is off for copying")
    }
}
