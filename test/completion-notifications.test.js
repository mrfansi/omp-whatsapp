import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { EventEmitter } from "node:events";

// All config and IPC stay in this disposable directory; never contact the live bridge.
const directory = await mkdtemp(join(tmpdir(), "omp-completion-test-"));
process.env.XDG_DATA_HOME = directory;
process.env.WA_STATE_DIR = directory;
await mkdir(join(directory, "omp/plugins"), { recursive: true });
const lockfile = join(directory, "omp/plugins/omp-plugins.lock.json");
await writeFile(lockfile, JSON.stringify({ settings: { "omp-whatsapp": { notifications: "terminal" } } }));
const { registerCompletionNotifications } = await import("../src/completion-notifications.js");
const { NOTIFY_SOCKET, MAX_REPORT_BYTES, MAX_REQUEST_BYTES, sendNotification } = await import("../src/notifications.js");
const reports = [];
const sockets = new Set();
const changes = new EventEmitter();
let acknowledge = true;
let acknowledgement = '{"ok":true}\n';
const server = createServer((socket) => {
	sockets.add(socket);
	socket.once("close", () => {
		sockets.delete(socket);
		changes.emit("change");
	});
	socket.on("error", () => {});
	let request = "";
	socket.setEncoding("utf8");
	socket.on("data", (data) => {
		request += data;
		if (!request.endsWith("\n")) return;
		reports.push({ text: JSON.parse(request).text, bytes: Buffer.byteLength(request) });
		changes.emit("change");
		if (acknowledge) socket.end(acknowledgement);
	});
});
before(() => new Promise((resolve, reject) => {
	server.once("error", reject);
	server.listen(NOTIFY_SOCKET, resolve);
}));
after(async () => {
	for (const socket of sockets) socket.destroy();
	await new Promise((resolve) => server.close(resolve));
	await rm(directory, { recursive: true, force: true });
});

function fixture(overrides = {}) {
	const hooks = new Map();
	const warnings = [];
	registerCompletionNotifications({ on: (name, handler) => hooks.set(name, handler) });
	const ctx = { mode: "tui", agent: { kind: "main" }, cwd: "/projects/example", hasPendingMessages: () => false,
		isIdle: () => false, ui: { notify: (...args) => {
			warnings.push(args);
			changes.emit("change");
		} }, ...overrides };
	return { emit: (name, event = {}) => hooks.get(name)(event, ctx), ctx, warnings };
}
function assistant(f, text, stopReason = "stop") {
	f.emit("message_end", { message: { role: "assistant", stopReason, content: [
		{ type: "thinking", thinking: "SECRET THINKING" }, { type: "text", text },
		{ type: "toolCall", name: "SECRET TOOL", arguments: {} },
	] } });
}
function waitFor(predicate, description) {
	if (predicate()) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			changes.removeListener("change", check);
		};
		const check = () => {
			if (!predicate()) return;
			cleanup();
			resolve();
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out waiting for ${description}`));
		}, 5000);
		changes.on("change", check);
		check();
	});
}
const eventLoopBoundary = () => new Promise((resolve) => setImmediate(resolve));
const deliveryFinished = (count) => waitFor(
	() => reports.length >= count && sockets.size === 0,
	"report acknowledgement and socket close",
);

test("one terminal-main completion includes only final text, despite isIdle being false", async () => {
	const count = reports.length;
	const f = fixture();
	f.emit("agent_start");
	assistant(f, "Earlier assistant answer");
	f.emit("message_end", { message: { role: "toolResult", content: "SECRET RESULT" } });
	assistant(f, "Final answer");
	f.emit("agent_end");
	f.emit("agent_end");
	await deliveryFinished(count + 1);
	assert.equal(reports.length, count + 1);
	assert.match(reports.at(-1).text, /Status: Turn completed/);
	assert.match(reports.at(-1).text, /Final assistant answer:\nFinal answer$/);
	assert.doesNotMatch(reports.at(-1).text, /SECRET|Earlier assistant/);
});

test("continuation and pending work retain state but do not send early", async () => {
	const count = reports.length;
	const f = fixture();
	f.emit("agent_start");
	assistant(f, "Not finished");
	f.emit("agent_end", { willContinue: true });
	f.emit("agent_start");
	f.ctx.hasPendingMessages = () => true;
	f.emit("agent_end");
	await eventLoopBoundary();
	assert.equal(reports.length, count);
	f.ctx.hasPendingMessages = () => false;
	assistant(f, "Finished continuation");
	f.emit("agent_end");
	await deliveryFinished(count + 1);
	assert.equal(reports.length, count + 1);
	assert.match(reports.at(-1).text, /Finished continuation$/);
});

test("RPC, print/JSON, and subagents never send", async () => {
	const count = reports.length;
	for (const overrides of [
		{ mode: "rpc", hasUI: true }, { mode: "print" }, { mode: "json" },
		{ agent: { kind: "sub", depth: 1 } }, { agent: { kind: "sub", depth: 0 } },
		{ agent: { kind: "advisor", depth: 0 } },
	]) {
		const f = fixture(overrides);
		f.emit("agent_start");
		assistant(f, "Excluded answer");
		f.emit("agent_end");
	}
	await eventLoopBoundary();
	assert.equal(reports.length, count);
});

test("off sends nothing and a subsequent empty run cannot reuse an old answer", async () => {
	const count = reports.length;
	const f = fixture();
	await writeFile(lockfile, JSON.stringify({ settings: { "omp-whatsapp": { notifications: "off" } } }));
	f.emit("agent_start");
	assistant(f, "STALE ANSWER");
	f.emit("agent_end");
	await eventLoopBoundary();
	assert.equal(reports.length, count);
	await writeFile(lockfile, JSON.stringify({ settings: { "omp-whatsapp": { notifications: "terminal" } } }));
	f.emit("agent_start");
	f.emit("agent_end");
	await deliveryFinished(count + 1);
	assert.equal(reports.length, count + 1);
	assert.doesNotMatch(reports.at(-1).text, /STALE/);
	assert.match(reports.at(-1).text, /completion not confirmed/);
});

test("error, abort, and output limit remain honest even with pruned agent_end messages", async () => {
	for (const [reason, label] of [["error", "Error"], ["aborted", "Aborted"], ["length", "Stopped at output limit (incomplete)"]]) {
		const count = reports.length;
		const f = fixture();
		f.emit("agent_start");
		assistant(f, "Partial answer", reason);
		f.emit("agent_end", { messages: [] });
		await deliveryFinished(count + 1);
		assert.ok(reports.at(-1).text.includes(`Status: ${label}`));
		assert.match(reports.at(-1).text, /Partial answer$/);
	}
});

test("large Unicode and JSON-escaped answers meet both bounds with explicit truncation", async () => {
	for (const answer of ["😀".repeat(40_000), "\u0000".repeat(60_000)]) {
		const count = reports.length;
		const f = fixture();
		f.emit("agent_start");
		assistant(f, answer);
		f.emit("agent_end");
		await deliveryFinished(count + 1);
		const report = reports.at(-1);
		assert.ok(Buffer.byteLength(report.text) <= MAX_REPORT_BYTES);
		assert.ok(report.bytes <= MAX_REQUEST_BYTES);
		assert.match(report.text, /\[Report truncated to fit notification limits\]$/);
		assert.doesNotMatch(report.text, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
	}
});

test("shutdown cancels outstanding delivery and prevents subsequent notifications", async () => {
	acknowledge = false;
	const before = reports.length;
	const f = fixture();
	f.emit("agent_start");
	assistant(f, "Outstanding delivery");
	f.emit("agent_end");
	await waitFor(() => reports.length === before + 1, "outstanding report request");
	const count = reports.length;
	f.emit("session_shutdown");
	f.emit("agent_start");
	assistant(f, "After shutdown");
	f.emit("agent_end");
	await waitFor(() => sockets.size === 0, "cancelled delivery socket close");
	await eventLoopBoundary();
	assert.equal(sockets.size, 0);
	assert.equal(reports.length, count);
	assert.equal(f.warnings.length, 0);
	acknowledge = true;
});

test("transport rejects pre-cancelled and invalid reports without opening a socket", async () => {
	const count = reports.length;
	await assert.rejects(sendNotification("hello", { signal: AbortSignal.abort() }), /cancelled/);
	await assert.rejects(sendNotification(" "), /nonempty/);
	await assert.rejects(sendNotification("x".repeat(MAX_REPORT_BYTES + 1)), /64 KiB/);
	await eventLoopBoundary();
	assert.equal(reports.length, count);
});

test("failed acknowledgement is caught, shown in the UI, and never retried", async () => {
	const count = reports.length;
	acknowledgement = '{"ok":false,"error":"recipient unavailable"}\n';
	const f = fixture();
	f.emit("agent_start");
	assistant(f, "Completed answer");
	f.emit("agent_end");
	await waitFor(() => f.warnings.length === 1, "failed acknowledgement UI warning");
	await deliveryFinished(count + 1);
	assert.equal(reports.length, count + 1);
	assert.equal(f.warnings.length, 1);
	assert.match(f.warnings[0][0], /recipient unavailable.*Not retried/);
	acknowledgement = '{"ok":true}\n';
});

test("manual report CLI retains file validation, output, and exit status", async () => {
	const execute = promisify(execFile);
	const cli = fileURLToPath(new URL("../src/send-report.js", import.meta.url));
	const file = join(directory, "manual.txt");
	await writeFile(file, "Manual report 😀");
	const result = await execute(process.execPath, [cli, file]);
	assert.equal(result.stdout, "Report sent\n");
	assert.equal(reports.at(-1).text, "Manual report 😀");
	await assert.rejects(execute(process.execPath, [cli, "relative.txt"]), (err) => {
		assert.equal(err.code, 1);
		assert.match(err.stderr, /Report failed: Usage:/);
		return true;
	});
	await writeFile(file, Buffer.from([0xff]));
	await assert.rejects(execute(process.execPath, [cli, file]), (err) => {
		assert.equal(err.code, 1);
		assert.match(err.stderr, /Report failed:/);
		return true;
	});
});
