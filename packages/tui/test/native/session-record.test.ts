import { afterEach, describe, expect, it } from "bun:test";
import { md } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import type { TspSession } from "@oh-my-pi/pi-wire";
import { TspHarness } from "./tsp-harness";

class Block implements Component {
	current: NativeNode;
	constructor(current: NativeNode) {
		this.current = current;
	}
	render(): readonly string[] {
		return ["block rows"];
	}
	describe(): NativeNode {
		return this.current;
	}
}

const WITH_SESSION = { features: ["blobs", "session"] } as const;

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
});

const record = (id: string, rev: number): { verb: string; body: TspSession } => ({
	verb: "n",
	body: { t: "session", id, rev },
});

/** Session records and the surface lifecycle and frames around them, from log index `from`. */
function sent(h: TspHarness, from = 0): { verb: string; body: unknown }[] {
	return h.terminal.log.slice(from).filter(message => ["n", "o", "f"].includes(message.verb));
}

/** Just the verbs of {@link sent}. */
function verbs(h: TspHarness, from = 0): string[] {
	return sent(h, from).map(message => message.verb);
}

describe("native session record", () => {
	it("names the session ahead of the first surface for a terminal whose hello lists `session`", async () => {
		harness = await TspHarness.start(tui => {
			tui.addChild(new Block(md("hello")));
			tui.setSessionId("s1");
		}, WITH_SESSION);
		const h = harness;
		expect(sent(h).slice(0, 2)).toEqual([
			record("s1", 0),
			{ verb: "o", body: expect.objectContaining({ mode: "inline" }) },
		]);
		expect(h.errors).toEqual([]);
	});

	it("sends no record to a terminal whose hello lacks `session`", async () => {
		const block = new Block(md("one"));
		harness = await TspHarness.start(tui => {
			tui.addChild(block);
			tui.setSessionId("s1");
		});
		const h = harness;
		h.tui.noteTranscriptReplaced();
		block.current = md("two");
		await h.render();
		h.tui.setSessionId("s2");
		await h.render();
		expect(h.frames.length).toBeGreaterThan(1);
		expect(h.terminal.log.filter(message => message.verb === "n")).toEqual([]);
	});

	it("restarts rev at 0 for a new session and raises it when a shown transcript is replaced", async () => {
		const block = new Block(md("one"));
		harness = await TspHarness.start(tui => {
			tui.addChild(block);
			tui.setSessionId("s1");
		}, WITH_SESSION);
		const h = harness;

		// The first frame showed s1's transcript: replacing it raises rev before the new frame.
		let from = h.terminal.log.length;
		h.tui.noteTranscriptReplaced();
		block.current = md("reset");
		await h.render();
		expect(verbs(h, from)).toEqual(["n", "f"]);
		expect(sent(h, from)[0]).toEqual(record("s1", 1));

		// A switch names the new session; its transcript replaces the old one before any frame showed it.
		from = h.terminal.log.length;
		h.tui.setSessionId("s2");
		h.tui.noteTranscriptReplaced();
		block.current = md("other session");
		await h.render();
		expect(sent(h, from)).toEqual([record("s2", 0), expect.objectContaining({ verb: "f" })]);

		// A frame of s2 went out, so the next replacement counts.
		from = h.terminal.log.length;
		h.tui.noteTranscriptReplaced();
		h.tui.noteTranscriptReplaced();
		expect(sent(h, from)).toEqual([record("s2", 1)]);
		expect(h.errors).toEqual([]);
	});

	it("sends the record again ahead of the adopt after a stop/start cycle's new hello", async () => {
		harness = await TspHarness.start(tui => {
			tui.addChild(new Block(md("kept")));
			tui.setSessionId("s1");
		}, WITH_SESSION);
		const h = harness;
		h.tui.noteTranscriptReplaced();
		await h.render();
		h.tui.stop();
		h.flush();
		const from = h.terminal.log.length;
		h.tui.start();
		h.flush();
		expect(sent(h, from).slice(0, 2)).toEqual([
			record("s1", 1),
			{ verb: "o", body: expect.objectContaining({ mode: "inline", adopt: true }) },
		]);
		expect(h.errors).toEqual([]);
	});

	it("sends the record ahead of the fresh surface that replaces one the terminal lost", async () => {
		harness = await TspHarness.start(tui => {
			tui.addChild(new Block(md("kept")));
			tui.setSessionId("s1");
		}, WITH_SESSION);
		const h = harness;
		const lost = h.terminal.surface!;
		const from = h.terminal.log.length;
		h.event({ ev: "gone", ids: [lost] });
		expect(sent(h, from).slice(0, 2)).toEqual([
			record("s1", 0),
			{ verb: "o", body: expect.objectContaining({ mode: "inline" }) },
		]);
		expect(h.terminal.surface).not.toBe(lost);
	});

	it("waits for the real hello after an optimistic start, then sends the record when it lists `session`", async () => {
		harness = await TspHarness.start(
			tui => {
				tui.addChild(new Block(md("hello")));
				tui.setSessionId("s1");
			},
			{ ...WITH_SESSION, expected: true, manualProbe: true },
		);
		const h = harness;
		expect(verbs(h)).toContain("o");
		expect(verbs(h)).not.toContain("n");
		h.terminal.answerProbe();
		h.flush();
		expect(sent(h).filter(message => message.verb === "n")).toEqual([record("s1", 0)]);
	});
});
