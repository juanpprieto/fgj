import type { WaitTimes } from "../core/verb.ts";

/**
 * The wait times of `status wait` and `run wait`. One call waits at most 90 s,
 * under Claude Code's 2-minute default for a shell command, then returns
 * pending with a `next` command. Forgejo writes the first check about 2 s after
 * a push, so 20 s without one means none.
 */
export const WAIT_TIMES: WaitTimes = {
	cap: 90_000,
	poll: 10_000,
	grace: 20_000,
};

/** One read of the thing a wait watches. */
export interface Reading<T> {
	/** True when the wait can end: a final state, or none after the grace. */
	done: boolean;
	value: T;
}

/**
 * Reads the wait times that tests set in `FGJ_WAIT_TIMES`, as `cap,poll,grace`
 * in milliseconds. fgj clamps them, so no value makes a call spin or wait
 * longer than the defaults.
 *
 * @param value - The env value, or undefined.
 * @returns The clamped times, or undefined when the value is missing or not three numbers.
 * @example
 * waitTimesFrom("3000,500,1500"); // { cap: 3000, poll: 500, grace: 1500 }
 */
export function waitTimesFrom(
	value: string | undefined,
): WaitTimes | undefined {
	const parts = /^(\d+),(\d+),(\d+)$/.exec(value ?? "");
	if (!parts) return undefined;
	return {
		cap: Math.min(Number(parts[1]), WAIT_TIMES.cap),
		poll: Math.max(Number(parts[2]), 100),
		grace: Math.min(Number(parts[3]), WAIT_TIMES.grace),
	};
}

/**
 * Reads again and again until a reading is done or the time is up. The cap
 * counts from `start`, so work before the loop counts too, and the loop stops
 * early enough for one more read and the work after it, such as a failure log.
 *
 * @param times - The cap, the poll interval, and the grace.
 * @param read - Reads once; gets the milliseconds since `start`.
 * @param start - When the call began. Default: now.
 * @returns The last reading; `done` is false when time ended the wait.
 * @example
 * const last = await pollUntil(WAIT_TIMES, async () => ({ done: true, value: 1 })); // { done: true, value: 1 }
 */
export async function pollUntil<T>(
	times: WaitTimes,
	read: (elapsed: number) => Promise<Reading<T>>,
	start = Date.now(),
): Promise<Reading<T>> {
	// Room for the work after the loop: a ninth of the cap, 10 s of 90 s.
	const reserve = Math.round(times.cap / 9);
	for (;;) {
		const began = Date.now();
		const reading = await read(began - start);
		if (reading.done) return reading;
		const took = Date.now() - began;
		const left = start + times.cap - Date.now();
		if (left < times.poll + took + reserve) return reading;
		await Bun.sleep(times.poll);
	}
}

/**
 * The whole seconds since a time that Forgejo gives, for `pending_s`.
 *
 * @param since - An ISO time, or undefined.
 * @param now - The current time in milliseconds.
 * @returns The seconds, or undefined when the time is missing or not valid.
 * @example
 * secondsSince("2026-09-29T06:16:59-07:00", Date.now()); // 42
 */
export function secondsSince(
	since: string | undefined,
	now: number,
): number | undefined {
	const at = since ? Date.parse(since) : Number.NaN;
	return Number.isFinite(at) && at > 0
		? Math.max(0, Math.round((now - at) / 1000))
		: undefined;
}
