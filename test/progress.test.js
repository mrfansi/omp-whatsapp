import assert from "node:assert/strict";
import test from "node:test";
import { createProgress, PROGRESS_BEAT_MS } from "../src/progress.js";

/** Records presence states and timer handles instead of touching a real socket or clock. */
function harness() {
	const states = [];
	const timers = [];
	const progress = createProgress({
		host: { sendPresenceUpdate: (state) => states.push(state) },
		setTimer: (fn, ms) => {
			const timer = {
				ms,
				fired: false,
				cleared: false,
				fn: () => {
					timer.fired = true;
					fn();
				},
			};
			timers.push(timer);
			return timer;
		},
		clearTimer: (timer) => {
			timer.cleared = true;
		},
	});
	return { states, progress, live: () => timers.filter((timer) => !timer.cleared && !timer.fired) };
}

test("start beats composing now, keeps beating on the interval, and repeats harmlessly", () => {
	const h = harness();
	h.progress.start();
	assert.deepEqual(h.states, ["composing"]);
	assert.equal(h.live().length, 1);
	assert.equal(h.live()[0].ms, PROGRESS_BEAT_MS);
	h.live()[0].fn();
	assert.deepEqual(h.states, ["composing", "composing"]);
	assert.equal(h.live().length, 1);
	h.progress.start();
	assert.equal(h.live().length, 1);
});

test("stop clears the beat, sends paused once, and stays quiet when idle", () => {
	const h = harness();
	h.progress.stop();
	assert.deepEqual(h.states, []);
	h.progress.start();
	const running = h.live()[0];
	h.progress.stop();
	assert.deepEqual(h.states, ["composing", "paused"]);
	assert.equal(running.cleared, true);
	assert.equal(h.live().length, 0);
	h.progress.stop();
	assert.deepEqual(h.states, ["composing", "paused"]);
	h.progress.start();
	assert.deepEqual(h.states, ["composing", "paused", "composing"]);
});
