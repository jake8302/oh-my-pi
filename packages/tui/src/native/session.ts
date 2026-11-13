/**
 * The session record (`n`) a TSP terminal with the `session` feature
 * receives: which session the visible transcript belongs to, and `rev`, one
 * counter for the whole process that goes up at each transcript replacement,
 * so the pair never repeats in one process. It outlives any one backend
 * (revoked optimistic starts, stop/start cycles), so the TUI owns it.
 */
import type { TspSession } from "@oh-my-pi/pi-wire";

export class NativeSession {
	#id: string | undefined;
	#rev = -1;

	/** The record to send; undefined until a transcript is named. */
	get record(): TspSession | undefined {
		return this.#id === undefined ? undefined : { t: "session", id: this.#id, rev: this.#rev };
	}

	/**
	 * The transcript of session `id` replaces the visible one. `rev` is 0 for
	 * the first transcript and goes up by 1 at each replacement after it, for
	 * the same id or another one.
	 */
	replace(id: string): void {
		this.#id = id;
		this.#rev++;
	}
}
