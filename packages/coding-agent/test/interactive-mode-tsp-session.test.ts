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
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TspSession } from "@oh-my-pi/pi-wire";
import * as utils from "@oh-my-pi/pi-utils";
import { ManualScheduler, TspTestTerminal } from "../../tui/test/native/tsp-harness";
import { createTestSession, type TestSessionContext } from "./utilities";

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

	it("names the session on start, raises rev on /clear and restarts it for the session /new starts", async () => {
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
		const records = () => terminal.log.filter(message => message.verb === "n").map(message => message.body);
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
});
