/**
 * The session record (`n`) a TSP terminal with the `session` feature
 * receives: which session the visible transcript belongs to, and `rev`, which
 * goes up when the transcript is replaced in place. It outlives any one
 * backend (revoked optimistic starts, stop/start cycles), so the TUI owns it.
 */
import type { TspSession } from "@oh-my-pi/pi-wire";

export class NativeSession {
	#id: string | undefined;
	#rev = 0;
	/** A frame went out since the current record was set, so a viewer may hold the transcript under it. */
	#shown = false;

	/** The record to send; undefined until a transcript is named. */
	get record(): TspSession | undefined {
		return this.#id === undefined ? undefined : { t: "session", id: this.#id, rev: this.#rev };
	}

	/**
	 * The transcript of session `id` replaces the visible one. Another id
	 * starts at `rev` 0. The same id raises `rev` only when a frame showed the
	 * transcript under the current record: a viewer that holds nothing under it
	 * cannot mistake the new transcript for the old one. Returns whether the
	 * record changed.
	 */
	replace(id: string): boolean {
		if (id !== this.#id) {
			this.#id = id;
			this.#rev = 0;
		} else if (this.#shown) {
			this.#rev++;
		} else {
			return false;
		}
		this.#shown = false;
		return true;
	}

	/** A frame of the session's surface went out. */
	shown(): void {
		this.#shown = true;
	}
}
