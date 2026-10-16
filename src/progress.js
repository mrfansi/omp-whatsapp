// WhatsApp progress. It is a presence heartbeat, never a message: Baileys cannot
// live-edit a sent message here — WhatsApp renders every edit of the progress
// message as one more empty bubble in the chat — so the bridge shows "typing…"
// and sends nothing.

/** Presence expires on its own; refresh well inside that window. */
export const PROGRESS_BEAT_MS = 8000;

/**
 * Presence heartbeat: "composing" now and every `intervalMs` until `stop()`,
 * which sends "paused". `start()` while running is a no-op.
 * @param {{host: {sendPresenceUpdate: (state: string) => unknown}, intervalMs?: number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout}} options
 */
export function createProgress({ host, intervalMs = PROGRESS_BEAT_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
	let timer = null;
	const beat = () => {
		host.sendPresenceUpdate("composing");
		timer = setTimer(beat, intervalMs);
	};
	return {
		start() {
			if (timer === null) beat();
		},
		stop() {
			if (timer === null) return;
			clearTimer(timer);
			timer = null;
			host.sendPresenceUpdate("paused");
		},
	};
}
