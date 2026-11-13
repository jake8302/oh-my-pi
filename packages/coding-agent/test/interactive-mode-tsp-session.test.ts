import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	cfgMarketplaceAutoUpdate,
	cfgStartupChangelogMode,
	cfgStartupCheckUpdate,
	cfgStartupSetupWizard,
	cfgStartupShowSplash,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { Text } from "@oh-my-pi/pi-tui";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import * as utils from "@oh-my-pi/pi-utils";
import type { TspSession } from "@oh-my-pi/pi-wire";
import { ManualScheduler, TspTestTerminal } from "../../tui/test/native/tsp-harness";
import { assistantMsg, createTestSession, type TestSessionContext, userMsg } from "./utilities";

/** A session record or frame as the terminal received it, with the surface's text right after it. */
interface Received {
	verb: "n" | "f";
	body: unknown;
	shows: string;
}

describe("InteractiveMode TSP session record", () => {
	let testSession: TestSessionContext | undefined;
	let mode: InteractiveMode | undefined;

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(async () => {
		mode?.stop();
		mode = undefined;
		await testSession?.cleanup();
		testSession = undefined;
		vi.restoreAllMocks();
		resetSettingsForTest();
		AgentStorage.close();
		HistoryStorage.close();
		closeSessionIndex();
		closeModelCache();
	});

	/** Start InteractiveMode on a TSP terminal whose hello lists `session`; record what it receives in order. */
	async function start() {
		testSession = await createTestSession();
		const { session, sessionManager, tempDir } = testSession;
		spyOn(utils, "getConfigRootDir").mockReturnValue(tempDir);
		await Settings.init({ inMemory: true, cwd: tempDir });
		cfgStartupCheckUpdate.override(session.settings, false);
		cfgStartupChangelogMode.override(session.settings, "hidden");
		cfgStartupSetupWizard.override(session.settings, false);
		cfgStartupShowSplash.override(session.settings, false);
		cfgMarketplaceAutoUpdate.override(session.settings, "off");
		const terminal = new TspTestTerminal({ features: ["blobs", "session"] });
		const received: Received[] = [];
		const write = terminal.write.bind(terminal);
		spyOn(terminal, "write").mockImplementation(data => {
			const from = terminal.log.length;
			write(data);
			for (const message of terminal.log.slice(from)) {
				if (message.verb !== "n" && message.verb !== "f") continue;
				const doc = terminal.surface === undefined ? undefined : terminal.docs.get(terminal.surface);
				received.push({ verb: message.verb, body: message.body, shows: JSON.stringify(doc?.snapshot() ?? null) });
			}
		});
		const scheduler = new ManualScheduler();
		const flush = () => scheduler.flush(0, () => terminal.answerProbe() || terminal.deliver());
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			new Composer({ terminal, tuiOptions: { renderScheduler: scheduler } }),
		);
		spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
		flush();
		const records = () => received.filter(entry => entry.verb === "n").map(entry => entry.body);
		return { mode, session, sessionManager, terminal, received, records, flush };
	}

	it("names the session on start, raises rev on /clear and restarts it for the session /new starts", async () => {
		const { mode, sessionManager, terminal, records, flush } = await start();
		const first = sessionManager.getSessionId();
		expect(records()).toEqual([{ t: "session", id: first, rev: 0 } satisfies TspSession]);

		await mode.handleResetContextCommand();
		flush();
		expect(sessionManager.getSessionId()).toBe(first);
		expect(records().at(-1)).toEqual({ t: "session", id: first, rev: 1 });

		await mode.handleClearCommand();
		flush();
		const second = sessionManager.getSessionId();
		expect(second).not.toBe(first);
		expect(records().at(-1)).toEqual({ t: "session", id: second, rev: 0 });
		expect(terminal.errors).toEqual([]);
	});

	it("names the /new session where its transcript replaces the old chat, not when the session id changes", async () => {
		const { mode, session, sessionManager, terminal, received, flush } = await start();
		const first = sessionManager.getSessionId();
		mode.present(new Text("OLD-CHAT-MARKER", 0, 0));
		flush();

		// Hold /new after the session id changed but before it returns, as a slow session_switch hook does.
		const refresh = session.refreshBaseSystemPrompt.bind(session);
		const reached = Promise.withResolvers<void>();
		const hook = Promise.withResolvers<void>();
		spyOn(session, "refreshBaseSystemPrompt").mockImplementation(async commitIf => {
			reached.resolve();
			await hook.promise;
			return refresh(commitIf);
		});
		const cleared = mode.handleClearCommand();
		await reached.promise;
		const second = sessionManager.getSessionId();
		expect(second).not.toBe(first);

		// A render in that window still shows the old chat, under the old record.
		const windowFrom = received.length;
		mode.present(new Text("WINDOW-MARKER", 0, 0));
		flush();
		const windowFrames = received.slice(windowFrom);
		expect(windowFrames.map(entry => entry.verb)).toContain("f");
		expect(windowFrames.filter(entry => entry.verb === "n")).toEqual([]);
		expect(windowFrames.every(entry => entry.shows.includes("OLD-CHAT-MARKER"))).toBe(true);

		hook.resolve();
		await cleared;
		flush();
		const named = received.findIndex(entry => entry.verb === "n" && (entry.body as TspSession).id === second);
		expect(received[named]?.body).toEqual({ t: "session", id: second, rev: 0 });
		const before = received.slice(0, named).filter(entry => entry.verb === "f");
		const after = received.slice(named + 1).filter(entry => entry.verb === "f");
		expect(before.some(entry => entry.shows.includes("New session started"))).toBe(false);
		expect(after.length).toBeGreaterThan(0);
		expect(after.some(entry => entry.shows.includes("OLD-CHAT-MARKER"))).toBe(false);
		expect(after.at(-1)?.shows).toContain("New session started");
		expect(terminal.errors).toEqual([]);
	});

	it("raises rev before the frame of a fast rewind that deletes the tail of the transcript", async () => {
		const { mode, sessionManager, terminal, received, records, flush } = await start();
		const id = sessionManager.getSessionId();
		sessionManager.appendMessage(userMsg("REWIND-KEEP"));
		const keep = sessionManager.appendMessage(assistantMsg("kept answer"));
		sessionManager.appendMessage(userMsg("REWIND-DROP"));
		sessionManager.appendMessage(assistantMsg("dropped answer"));
		await mode.renderInitialMessages();
		flush();
		expect(received.at(-1)?.shows).toContain("REWIND-DROP");
		const rev = (records().at(-1) as TspSession).rev;

		const dropped = sessionManager
			.getEntries()
			.find(
				entry =>
					entry.type === "message" && entry.message.role === "user" && entry.message.content === "REWIND-DROP",
			);
		if (dropped?.type !== "message") throw new Error("expected the dropped user message entry");
		sessionManager.branch(keep);
		const from = received.length;
		expect(mode.truncateTranscriptFromMessage(dropped.message)).toBe(true);
		flush();
		const rewind = received.slice(from);
		const deletion = rewind.findIndex(entry => entry.verb === "f" && !entry.shows.includes("REWIND-DROP"));
		expect(deletion).toBeGreaterThan(0);
		expect(rewind.slice(0, deletion)).toEqual([
			{ verb: "n", body: { t: "session", id, rev: rev + 1 }, shows: expect.any(String) },
		]);
		expect(terminal.errors).toEqual([]);
	});
});
