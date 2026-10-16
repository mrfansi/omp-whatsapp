// Local text-only report delivery through the daemon's existing WhatsApp connection.
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { STATE_DIR } from "./config.js";

export const NOTIFY_SOCKET = join(STATE_DIR, "notify.sock");
export const MAX_REPORT_BYTES = 64 * 1024;
export const MAX_REQUEST_BYTES = 128 * 1024;
export const REPORT_TIMEOUT_MS = 90_000;

/** Deliver one text report, with a bounded acknowledgement and no reconnect/retry. */
export async function sendNotification(text, { signal } = {}) {
	if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > MAX_REPORT_BYTES) {
		throw new Error("Report must contain nonempty text no larger than 64 KiB");
	}
	const request = `${JSON.stringify({ text })}\n`;
	if (Buffer.byteLength(request) > MAX_REQUEST_BYTES) throw new Error("Encoded notification request is too large");
	if (signal?.aborted) throw new Error("Report delivery cancelled");
	await new Promise((resolve, reject) => {
		const client = createConnection(NOTIFY_SOCKET);
		let settled = false;
		let response = "";
		const finish = (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			client.destroy();
			if (err) reject(err); else resolve();
		};
		const cancel = () => finish(new Error("Report delivery cancelled"));
		const timer = setTimeout(() => finish(new Error("Report acknowledgement timed out; do not retry automatically")), REPORT_TIMEOUT_MS + 5000);
		signal?.addEventListener("abort", cancel, { once: true });
		client.setEncoding("utf8");
		client.once("connect", () => client.write(request));
		client.once("error", () => finish(new Error("Cannot reach report notification socket")));
		client.once("close", () => finish(new Error("Notification socket disconnected before acknowledgement")));
		client.on("data", (data) => {
			response += data;
			if (response.length > 4096) { finish(new Error("Invalid notification acknowledgement")); return; }
			if (!response.includes("\n")) return;
			try {
				if (response.indexOf("\n") !== response.length - 1) throw new Error();
				const result = JSON.parse(response);
				if (result?.ok === true && Object.keys(result).length === 1) finish();
				else if (result?.ok === false && typeof result.error === "string") finish(new Error(result.error));
				else throw new Error();
			} catch { finish(new Error("Invalid notification acknowledgement")); }
		});
	});
}

function ownedSocket(path) {
	try {
		const stat = lstatSync(path);
		if (!stat.isSocket() || stat.uid !== process.getuid()) {
			throw new Error("Notification path is not an owned Unix socket");
		}
		return stat;
	} catch (err) {
		if (err.code === "ENOENT") return null;
		throw err;
	}
}

function unlinkSocket(path, expected) {
	let current;
	try { current = lstatSync(path); }
	catch (err) { if (err.code === "ENOENT") return; throw err; }
	if (current.isSocket() && current.uid === process.getuid() && expected &&
		current.dev === expected.dev && current.ino === expected.ino) unlinkSync(path);
}

async function removeStaleSocket(path) {
	const existing = ownedSocket(path);
	if (!existing) return;
	await new Promise((resolve, reject) => {
		const probe = createConnection(path);
		probe.setTimeout(1000);
		probe.once("connect", () => {
			probe.destroy();
			reject(new Error("Notification socket is already in use"));
		});
		probe.once("timeout", () => {
			probe.destroy();
			reject(new Error("Cannot establish whether notification socket is stale"));
		});
		probe.once("error", (err) => {
			if (err.code === "ECONNREFUSED") {
				try { unlinkSocket(path, existing); resolve(); } catch (error) { reject(error); }
			} else if (err.code === "ENOENT") resolve();
			else reject(new Error("Cannot inspect notification socket"));
		});
	});
}

/** send(text, cancelled) must await every WhatsApp send and never alter the chat/session. */
export async function startNotifications(send, onError = () => {}) {
	await removeStaleSocket(NOTIFY_SOCKET);
	const clients = new Set();
	let busy = false;
	let owned = null;
	const server = createServer((client) => {
		if (clients.size >= 8) { client.destroy(); return; }
		clients.add(client);
		let finished = false;
		let received = false;
		let size = 0;
		const buffers = [];
		const respond = (result) => {
			if (finished) return;
			finished = true;
			clearTimeout(deadline);
			client.end(`${JSON.stringify(result)}\n`);
		};
		const deadline = setTimeout(() => {
			respond({ ok: false, error: "Report delivery timed out; do not retry automatically" });
		}, REPORT_TIMEOUT_MS);
		client.setTimeout(10_000, () => {
			if (!received) respond({ ok: false, error: "Notification request timed out" });
		});
		client.on("error", () => {});
		client.once("close", () => { finished = true; clearTimeout(deadline); clients.delete(client); });
		client.on("data", async (data) => {
			if (finished) return;
			if (received) { respond({ ok: false, error: "Only one request is allowed" }); return; }
			size += data.length;
			if (size > MAX_REQUEST_BYTES) { respond({ ok: false, error: "Notification request is too large" }); return; }
			buffers.push(data);
			if (!data.includes(10)) return;
			received = true;
			client.setTimeout(0);
			let text;
			try {
				const bytes = Buffer.concat(buffers, size);
				if (bytes.indexOf(10) !== bytes.length - 1) throw new Error();
				const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1)));
				if (!request || Array.isArray(request) || Object.keys(request).length !== 1 || typeof request.text !== "string") throw new Error();
				text = request.text;
				if (!text.trim() || Buffer.byteLength(text, "utf8") > MAX_REPORT_BYTES) throw new Error();
			} catch {
				respond({ ok: false, error: "Expected one bounded JSON request containing only nonempty text" });
				return;
			}
			if (busy) { respond({ ok: false, error: "Another report is being delivered" }); return; }
			busy = true;
			try {
				await send(text, () => finished || client.destroyed);
				respond({ ok: true });
			} catch (err) {
				respond({ ok: false, error: err.message });
			} finally { busy = false; }
		});
	});
	// Restrict access from the moment bind creates the socket, not just after chmod.
	const oldMask = process.umask(0o177);
	try {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(NOTIFY_SOCKET, () => {
				server.removeListener("error", reject);
				try { owned = ownedSocket(NOTIFY_SOCKET); chmodSync(NOTIFY_SOCKET, 0o600); resolve(); }
				catch (err) { reject(err); }
			});
		});
	} catch (err) {
		server.close();
		if (owned) unlinkSocket(NOTIFY_SOCKET, owned);
		throw err;
	} finally { process.umask(oldMask); }
	server.on("error", onError);
	return () => {
		for (const client of clients) client.destroy();
		server.close();
		unlinkSocket(NOTIFY_SOCKET, owned);
	};
}
