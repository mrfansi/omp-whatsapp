// Terminal-main completion reports; never expose the transcript or thinking/tool output.
import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import { loadSettings } from "./config.js";
import { MAX_REPORT_BYTES, MAX_REQUEST_BYTES, sendNotification } from "./notifications.js";

const terminalMain = (ctx) => ctx.mode === "tui" && ctx.agent?.kind === "main";
const fits = (text) => Buffer.byteLength(text, "utf8") <= MAX_REPORT_BYTES &&
	Buffer.byteLength(`${JSON.stringify({ text })}\n`, "utf8") <= MAX_REQUEST_BYTES;

function boundedReport(text) {
	if (fits(text)) return text;
	const marker = "\n\n[Report truncated to fit notification limits]";
	// Binary search both bounds: JSON escaping can exceed the IPC limit before UTF-8 does.
	let low = 0;
	let high = text.length;
	const prefix = (length) => {
		const last = text.charCodeAt(length - 1);
		if (last >= 0xd800 && last <= 0xdbff) length--;
		return text.slice(0, length);
	};
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (fits(prefix(middle) + marker)) low = middle;
		else high = middle - 1;
	}
	return prefix(low) + marker;
}

function completionStatus(message) {
	switch (message?.stopReason) {
		case "error": return "Error";
		case "aborted": return "Aborted";
		case "length": return "Stopped at output limit (incomplete)";
		case "stop": return "Turn completed (task/test success not verified)";
		default: return "Turn ended (completion not confirmed)";
	}
}

export function registerCompletionNotifications(pi) {
	let work = null;
	let shutdown = false;
	const deliveries = new Set();

	pi.on("agent_start", (_event, ctx) => {
		if (!shutdown && terminalMain(ctx) && !work) {
			work = { started: performance.now(), cwd: ctx.cwd, message: null };
		}
	});
	pi.on("message_end", (event, ctx) => {
		if (!shutdown && terminalMain(ctx) && work && event.message?.role === "assistant") {
			// Capture even empty failure/abort messages, which can be pruned from agent_end.messages.
			const message = event.message;
			work.message = {
				stopReason: message.stopReason,
				text: Array.isArray(message.content)
					? message.content.filter((part) => part.type === "text" && typeof part.text === "string")
						.map((part) => part.text).join("\n").trim()
					: "",
			};
		}
	});
	pi.on("agent_end", (event, ctx) => {
		if (shutdown || !terminalMain(ctx) || !work) return;
		if (event.willContinue === true || ctx.hasPendingMessages()) return;
		const completed = work;
		work = null; // Reset before delivery: duplicate ends and the next run cannot reuse this answer.
		if (loadSettings().notifications !== "terminal") return;
		const seconds = Math.max(0, Math.round((performance.now() - completed.started) / 1000));
		const text = boundedReport([
			"OMP terminal work finished",
			`Project: ${basename(completed.cwd) || completed.cwd}`,
			`Directory: ${completed.cwd}`,
			`Status: ${completionStatus(completed.message)}`,
			`Elapsed: ${seconds}s`,
			"",
			"Final assistant answer:",
			completed.message?.text || "(No final assistant text was produced.)",
		].join("\n"));
		const controller = new AbortController();
		deliveries.add(controller);
		// The extension handler must return promptly; report IPC can take up to 95 seconds.
		void sendNotification(text, { signal: controller.signal }).catch((err) => {
			if (shutdown || controller.signal.aborted) return;
			try { ctx.ui.notify(`WhatsApp completion notification failed: ${err.message}. Not retried.`, "warning"); }
			catch { /* UI may already be unavailable; delivery must never fail completed work. */ }
		}).finally(() => deliveries.delete(controller));
	});
	pi.on("session_shutdown", () => {
		shutdown = true;
		work = null;
		for (const controller of deliveries) controller.abort();
		deliveries.clear();
	});
}
