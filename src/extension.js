// omp extension: `/whatsapp` manages the bridge service from inside omp.
// The bridge itself runs as a systemd user service (src/index.js) so WhatsApp
// stays reachable when no omp session is open; settings are omp plugin settings.
import { execFile, spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import qrcode from "qrcode-terminal";
import { AUTH_DIR, PACKAGE_DIR, PLUGIN_NAME, SERVICE, loadSettings } from "./config.js";
import { registerCompletionNotifications } from "./completion-notifications.js";

const SUBCOMMANDS = [
	{ value: "status", description: "Service, linked account, and settings" },
	{ value: "set", description: "set <allowedNumbers|cwd|model|thinking|progress|notifications> <value>" },
	{ value: "start", description: "Enable and start the bridge service" },
	{ value: "stop", description: "Stop and disable the bridge service" },
	{ value: "restart", description: "Restart the bridge service" },
	{ value: "logs", description: "Last 30 log lines" },
	{ value: "pair", description: "pair: link with a QR code; pair <bot number>: link with a pairing code" },
];
const SETTING_KEYS = ["allowedNumbers", "cwd", "model", "thinking", "progress", "notifications"];
const LIVE_KEYS = new Set(["allowedNumbers", "progress", "notifications"]);
const PAIR_TIMEOUT_MS = 5 * 60 * 1000;
let pairing = null; // running pair child process

function run(cmd, args) {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) =>
			resolve({ ok: !err, out: `${stdout}${stderr}`.trim(), code: err?.code }),
		);
	});
}

const systemctl = (...args) => run("systemctl", ["--user", ...args]);

/** Linked bot number, or null. `creds.account` only exists after a completed pairing. */
function linkedAccount() {
	try {
		const creds = JSON.parse(readFileSync(join(AUTH_DIR, "creds.json"), "utf8"));
		return creds.account && creds.me?.id ? creds.me.id.split(":")[0].split("@")[0] : null;
	} catch {
		return null;
	}
}

async function status() {
	const [active, enabled] = await Promise.all([systemctl("is-active", SERVICE), systemctl("is-enabled", SERVICE)]);
	const s = loadSettings();
	const account = linkedAccount();
	return [
		`Service: ${active.out || "unknown"} (${enabled.out || "unknown"})`,
		`Bot account: ${account ?? "not linked — /whatsapp pair (QR) or /whatsapp pair <bot-number> (code)"}`,
		`allowedNumbers: ${[...s.allowedNumbers].join(", ") || "(empty — all messages are ignored)"}`,
		`cwd default: ${s.cwd}`,
		`model: ${s.model || "(default omp)"}`,
		`thinking: ${s.thinking}`,
		`progress: ${s.progress}`,
		`notifications: ${s.notifications}`,
		"Change: /whatsapp set <key> <value>, /settings → Plugins, or omp plugin config set omp-whatsapp <key> <value>",
	].join("\n");
}

async function setSetting(rest) {
	const [key, ...valueParts] = rest;
	if (!SETTING_KEYS.includes(key)) return { text: `Key must be one of: ${SETTING_KEYS.join(", ")}`, level: "error" };
	const value = valueParts.join(" ");
	const res = value
		? await run("omp", ["plugin", "config", "set", PLUGIN_NAME, key, value])
		: await run("omp", ["plugin", "config", "delete", PLUGIN_NAME, key]);
	if (!res.ok) return { text: res.out || `Failed to save ${key}`, level: "error" };
	return {
		text: `${key} = ${value || "(default)"}. ${LIVE_KEYS.has(key) ? "Applied immediately." : "The bridge applies it once the agent is idle."}`,
		level: "info",
	};
}

/**
 * Link the bot account. Without a number a QR panel replaces the editor (interactive TUI
 * only); with a number a pairing code is shown. The service is stopped meanwhile because
 * it shares the auth dir.
 */
async function pair(phone, ctx) {
	const digits = (phone ?? "").replace(/\D/g, "");
	if (linkedAccount()) {
		return {
			text: `Already linked as ${linkedAccount()}. To relink, unlink the device on the phone first, then delete ${AUTH_DIR}.`,
			level: "warning",
		};
	}
	if (pairing) return { text: "Pairing is already running.", level: "warning" };
	if (!digits && !ctx.hasUI) {
		return { text: "The QR panel needs the omp terminal UI. Use /whatsapp pair <bot-number> for a pairing code.", level: "error" };
	}
	await systemctl("stop", SERVICE);
	// Leftovers of an unfinished attempt would reuse a dead pairing session.
	rmSync(AUTH_DIR, { recursive: true, force: true });
	const env = digits ? { WA_PAIR_PHONE: digits } : { WA_PAIR_QR_RAW: "1" };
	const child = spawn("node", [join(PACKAGE_DIR, "src/index.js"), "--pair"], {
		cwd: PACKAGE_DIR,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	pairing = child;
	let output = "";
	child.stdout.on("data", (chunk) => (output += chunk));
	child.stderr.on("data", (chunk) => (output += chunk));
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
	}, PAIR_TIMEOUT_MS);
	const exited = new Promise((resolve) => child.on("exit", resolve));

	let cancelled = false;
	if (digits) {
		ctx.ui.notify("Requesting a pairing code from WhatsApp…", "info");
		showPairingCodes(child, ctx);
	} else {
		const outcome = await showQrPanel(child, exited, ctx);
		if (outcome === undefined) {
			// custom UI unsupported on this surface (RPC): resolves immediately
			child.kill("SIGTERM");
			await exited;
			clearTimeout(timer);
			pairing = null;
			return { text: "The QR panel needs the omp terminal UI. Use /whatsapp pair <bot-number> for a pairing code.", level: "error" };
		}
		if (outcome === "cancelled") {
			cancelled = true;
			child.kill("SIGTERM");
		}
	}
	const code = await exited;
	clearTimeout(timer);
	pairing = null;
	if (cancelled) return { text: "Pairing cancelled.", level: "warning" };
	if (code !== 0) {
		const reason = timedOut ? "timed out after 5 minutes" : `exit ${code}`;
		const tail = output.trim().split("\n").filter((l) => !/QR: /.test(l)).slice(-5).join("\n");
		return { text: `Pairing failed (${reason}).\n${tail}`, level: "error" };
	}
	const started = await systemctl("enable", "--now", SERVICE);
	return {
		text: `Linked as ${linkedAccount() ?? digits}. ${started.ok ? "Service is running." : `Service failed to start: ${started.out}`}`,
		level: started.ok ? "info" : "error",
	};
}

/** Notify every pairing code; a reconnect (e.g. WhatsApp's QR timeout) issues a new one and kills the old. */
function showPairingCodes(child, ctx) {
	let shown = 0;
	for (const stream of [child.stdout, child.stderr]) {
		createInterface({ input: stream }).on("line", (line) => {
			const code = /Pairing code: (\S+)/.exec(line)?.[1];
			if (!code) return;
			shown++;
			ctx.ui.notify(
				`Pairing code: ${code}${shown > 1 ? " (new code; the previous one expired)" : ""}\nOn the bot phone: WhatsApp → Linked devices → Link a device → Link with phone number instead.`,
				"info",
			);
		});
	}
}

/**
 * Render the pairing QR in place of the editor until linked, failed, or Esc.
 * @returns {Promise<"linked"|"failed"|"cancelled"|undefined>} undefined when custom UI is unsupported
 */
function showQrPanel(child, exited, ctx) {
	return ctx.ui.custom((tui, theme, _keybindings, done) => {
		let qrLines = [];
		let status = "Connecting to WhatsApp…";
		let cache = null;
		const update = () => {
			cache = null;
			tui.requestRender();
		};
		createInterface({ input: child.stdout }).on("line", (line) => {
			const qr = /QR: (\S+)/.exec(line)?.[1];
			if (qr) {
				qrcode.generate(qr, { small: true }, (text) => (qrLines = text.replace(/\n+$/, "").split("\n")));
				status = "Scan with the bot phone: WhatsApp → Linked devices → Link a device. The QR refreshes by itself; scan the one shown.";
				update();
			} else if (/WhatsApp connected as/.test(line)) {
				status = "Linked. Finishing…";
				update();
			}
		});
		exited.then((code) => done(code === 0 ? "linked" : "failed"));
		return {
			render(width) {
				if (cache?.width === width) return cache.lines;
				const qrWidth = Math.max(0, ...qrLines.map((l) => [...l].length));
				const fit = (s) => (s.length > width ? s.slice(0, width) : s);
				const body =
					qrWidth > width
						? wrap(`Terminal too narrow for the QR (${qrWidth} columns needed, ${width} available). Widen it, or press Esc and use /whatsapp pair <bot-number>.`, width)
						: qrLines;
				const lines = [
					fit(theme.bold ? theme.bold("WhatsApp pairing") : "WhatsApp pairing"),
					"",
					...body,
					"",
					...wrap(status, width),
					fit("Esc: cancel"),
				];
				cache = { width, lines };
				return lines;
			},
			handleInput(data) {
				if (data === "\x1b" || data === "\x03" || data.startsWith("\x1b[27")) done("cancelled");
			},
			invalidate() {
				cache = null;
			},
		};
	});
}

function wrap(text, width) {
	const out = [];
	let line = "";
	for (const word of text.split(" ")) {
		if (line && line.length + 1 + word.length > width) {
			out.push(line);
			line = word;
		} else line = line ? `${line} ${word}` : word;
	}
	if (line) out.push(line.slice(0, width));
	return out;
}

async function dispatch(args, ctx) {
	const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
	switch (sub) {
		case "status":
			return { text: await status(), level: "info" };
		case "set":
			return setSetting(rest);
		case "start": {
			const r = await systemctl("enable", "--now", SERVICE);
			return r.ok ? { text: await status(), level: "info" } : { text: r.out, level: "error" };
		}
		case "stop": {
			const r = await systemctl("disable", "--now", SERVICE);
			return r.ok ? { text: "Bridge stopped; autostart disabled.", level: "info" } : { text: r.out, level: "error" };
		}
		case "restart": {
			const r = await systemctl("restart", SERVICE);
			return r.ok ? { text: "Bridge restarted.", level: "info" } : { text: r.out, level: "error" };
		}
		case "logs": {
			const r = await run("journalctl", ["--user", "-u", SERVICE, "-n", "30", "-o", "cat", "--no-pager"]);
			return { text: r.out || "(no log lines)", level: r.ok ? "info" : "error" };
		}
		case "pair":
			return pair(rest[0], ctx);
		default:
			return { text: `Unknown subcommand: ${sub}. Options: ${SUBCOMMANDS.map((s) => s.value).join(", ")}`, level: "error" };
	}
}

export default function whatsapp(pi) {
	pi.setLabel("WhatsApp");
	registerCompletionNotifications(pi);
	pi.registerCommand("whatsapp", {
		description: "Manage the WhatsApp bridge (status, set, start, stop, restart, logs, pair)",
		getArgumentCompletions(prefix) {
			const [sub, ...rest] = prefix.split(/\s+/);
			if (sub === "set" && rest.length === 1) {
				return SETTING_KEYS.filter((k) => k.startsWith(rest[0])).map((k) => ({ value: `set ${k} `, label: k }));
			}
			if (sub === "set" && rest.length === 2 && rest[0] === "notifications") {
				return ["off", "terminal"].filter((value) => value.startsWith(rest[1]))
					.map((value) => ({ value: `set notifications ${value}`, label: value }));
			}
			if (rest.length) return null;
			return SUBCOMMANDS.filter((s) => s.value.startsWith(sub)).map((s) => ({ ...s, label: s.value }));
		},
		async handler(args, ctx) {
			const { text, level } = await dispatch(args, ctx);
			ctx.ui.notify(text, level);
		},
	});
}
