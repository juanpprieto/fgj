import { describe, expect, test } from "bun:test";
import { pollUntil, WAIT_TIMES, waitTimesFrom } from "../../src/verbs/wait.ts";

describe("wait times", () => {
	test("FGJ_WAIT_TIMES is clamped: no poll below 100 ms, no cap or grace above the defaults", () => {
		expect(waitTimesFrom("3000,500,1500")).toEqual({
			cap: 3000,
			poll: 500,
			grace: 1500,
		});
		expect(waitTimesFrom("999999999,0,999999999")).toEqual({
			cap: WAIT_TIMES.cap,
			poll: 100,
			grace: WAIT_TIMES.grace,
		});
		expect(waitTimesFrom("1,2")).toBeUndefined();
		expect(waitTimesFrom(undefined)).toBeUndefined();
	});

	test("a slow read and time spent before the loop stay inside the cap", async () => {
		const times = { cap: 1000, poll: 100, grace: 0 };
		// 400 ms passed before the loop started, and each read takes 150 ms.
		const start = Date.now() - 400;
		let reads = 0;
		const last = await pollUntil(
			times,
			async () => {
				reads++;
				await Bun.sleep(150);
				return { done: false, value: reads };
			},
			start,
		);
		expect(last.done).toBe(false);
		// The loop leaves room for one more read and the work after it.
		expect(Date.now() - start).toBeLessThanOrEqual(1000);
	});
	test("a cap of 3x the grace lets the grace end a wait with slow reads", async () => {
		// The wait tests' times, scaled down 4 times: grace 250 ms, poll 62 ms,
		// and reads of 150 ms, as under parallel load. A cap of 2x the grace
		// returns before the grace; the real-server tests showed it.
		const last = await pollUntil(
			{ cap: 750, poll: 62, grace: 250 },
			async (elapsed) => {
				await Bun.sleep(150);
				return { done: elapsed >= 250, value: elapsed };
			},
		);
		expect(last.done).toBe(true);
	});
});
