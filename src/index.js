// WhatsApp <-> omp bridge. Links a WhatsApp account via Baileys (WhatsApp Web
// multi-device) and relays 1:1 messages from allowlisted numbers to one
// `omp --mode rpc-ui` session running with the user's normal omp config
// (skills, MCP, memory, extensions, slash commands). Sessions live in omp's
// default session store, so terminal `omp --resume` sees them and vice versa.
// Settings come from omp's plugin config (see config.js) and are hot-reloaded.
//
//   node src/index.js          run the bridge (expects an already linked account)
//   node src/index.js --pair   link the account (QR in terminal, or pairing code
//                              when WA_PAIR_PHONE is set), then exit
import { mkdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import makeWASocket, {
	Browsers,
	DisconnectReason,
	downloadMediaMessage,
	fetchLatestBaileysVersion,
	useMultiFileAuthState,
} from "baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { AUTH_DIR, STATE_DIR, loadSettings, lockfilePath } from "./config.js";
import { OmpAgent } from "./omp-rpc.js";
import { ago, listSessions, resolveProject, tildify } from "./workspace.js";
import { startNotifications } from "./notifications.js";
import { createProgress } from "./progress.js";

const PAIR_MODE = process.argv.includes("--pair");
const env = process.env;
const INBOX_DIR = join(STATE_DIR, "inbox");
const STATE_FILE = join(STATE_DIR, "state.json");
const MAX_CHUNK = 3500;
const MAX_MESSAGE_AGE_S = 10 * 60;
const MAX_SEND_BYTES = 64 * 1024 * 1024;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const MIME_EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };

for (const dir of [AUTH_DIR, INBOX_DIR]) mkdirSync(dir, { recursive: true, mode: 0o700 });

const logger = pino({ level: env.WA_LOG_LEVEL || "warn" });
const log = (...args) => console.log(new Date().toISOString(), ...args);

let settings = loadSettings();

/** Persisted bridge state: current project and session. */
function loadState() {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return {};
	}
}
let state = loadState();
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });

const HELP = [
	"*omp via WhatsApp*",
	"Plain messages go to the agent. Images and documents are forwarded (and saved to the inbox).",
	"omp slash commands work like in the terminal: /model, /switch, /compact, /todo, /mcp, /rename, /session, /skill:<name>, /usage, /move, …",
	"Agent questions (ask tool): reply with an option number or free text.",
	"",
	"*Bridge commands*",
	"/cd <project|path> — switch project (new session in that folder)",
	"/new — new session in the same project",
	"/resume — list this project's sessions (terminal ones included); /resume <n> to continue",
	"/stop — stop the running work / cancel a question",
	"/status — project, session, model, context",
	"/help — this help",
].join("\n");

const SYSTEM_APPEND = [
	"The user is talking to you through a WhatsApp chat bridge on host mrfansi-dev, reading on a phone.",
	"Keep replies short and in the user's language. WhatsApp formatting: *bold*, _italic_, ~strike~, ```code```; no markdown headings, tables, or [text](url) links.",
	"The `ask` tool works: the user answers from WhatsApp by option number or free text.",
	"Files and images the user sends are saved under the inbox path given in their message.",
	"To deliver a file or image to the user, call the `whatsapp_send_file` tool with an absolute path.",
].join("\n");

const HOST_TOOLS = [
	{
		name: "whatsapp_send_file",
		label: "WhatsApp send file",
		description:
			"Send a local file to the user's WhatsApp chat. Images (png/jpg/webp/gif) are sent as photos, everything else as documents. Max 64 MiB.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute path of the file to send" },
				caption: { type: "string", description: "Optional caption" },
			},
			required: ["path"],
			additionalProperties: false,
		},
		loadMode: "essential",
	},
];

// ---------------------------------------------------------------------------
// WhatsApp formatting

/** Convert common Markdown to WhatsApp markup, leaving code blocks untouched. */
function toWhatsApp(md) {
	return md
		.split(/(```[\s\S]*?```)/g)
		.map((part, i) => {
			if (i % 2) return part;
			return part
				.replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
				.replace(/\*\*(.+?)\*\*/g, "*$1*")
				.replace(/__(.+?)__/g, "_$1_")
				.replace(/~~(.+?)~~/g, "~$1~")
				.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)");
		})
		.join("");
}

function chunk(text) {
	const out = [];
	let rest = text;
	while (rest.length > MAX_CHUNK) {
		let cut = rest.lastIndexOf("\n", MAX_CHUNK);
		if (cut < MAX_CHUNK / 2) cut = MAX_CHUNK;
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest.trim()) out.push(rest);
	return out;
}

// ---------------------------------------------------------------------------
// WhatsApp connection

let sock = null;
let activeJid = null; // chat that receives agent output
let agent = null;
let connected = false;
let shuttingDown = false;
let reconnectTimer = null;
let stopNotifications = null;

async function sendReport(text, cancelled) {
	const allowedNumbers = loadSettings().allowedNumbers;
	if (allowedNumbers.size !== 1) throw new Error("Reports require exactly one allowed number");
	const jid = `${[...allowedNumbers][0]}@s.whatsapp.net`;
	const socket = sock;
	if (!connected || !socket || shuttingDown) throw new Error("WhatsApp is not connected");
	for (const part of chunk(toWhatsApp(text))) {
		if (cancelled()) throw new Error("Report delivery cancelled");
		const current = loadSettings().allowedNumbers;
		if (current.size !== 1 || !current.has(jid.split("@")[0])) throw new Error("Report recipient settings changed");
		if (!connected || sock !== socket || shuttingDown) throw new Error("WhatsApp disconnected during report delivery");
		try { await socket.sendMessage(jid, { text: part }); }
		catch { throw new Error("WhatsApp report send failed; delivery may be partial"); }
		if (cancelled() || !connected || sock !== socket || shuttingDown) throw new Error("Report delivery interrupted; delivery may be partial");
	}
}

async function connect() {
	if (shuttingDown) return;
	const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
	const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
	if (shuttingDown) return;
	const socket = makeWASocket({
		version,
		auth,
		logger,
		// Must be a canonical browser: the pairing-code handshake sends "<browser> (<os>)" and
		// WhatsApp rejects custom names, so the phone shows "Couldn't link device".
		browser: Browsers.ubuntu("Chrome"),
		markOnlineOnConnect: false,
		syncFullHistory: false,
	});
	sock = socket;
	connected = false;
	socket.ev.on("creds.update", saveCreds);

	let codeRequested = false;
	socket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
		if (sock !== socket || shuttingDown) return;
		// The first QR event means the socket is ready for a pairing-code request.
		if (qr && PAIR_MODE && env.WA_PAIR_PHONE && !codeRequested && !auth.creds.registered) {
			codeRequested = true;
			try {
				const code = await socket.requestPairingCode(env.WA_PAIR_PHONE.replace(/\D/g, ""));
				log(`Pairing code: ${code}  (WhatsApp → Linked devices → Link a device → Link with phone number)`);
			} catch (err) {
				log(`Pairing code request failed: ${err.message}`);
			}
		}
		if (qr && PAIR_MODE && env.WA_PAIR_QR_RAW) {
			log(`QR: ${qr}`); // rendered by the /whatsapp pair panel in omp
		} else if (qr && PAIR_MODE && !env.WA_PAIR_PHONE) {
			log("Scan this QR: WhatsApp → Linked devices → Link a device");
			qrcode.generate(qr, { small: true });
		}
		if (qr && !PAIR_MODE) {
			log("WhatsApp account is not linked. In omp run: /whatsapp pair");
			process.exit(2);
		}
		if (connection === "open") {
			connected = true;
			log(`WhatsApp connected as ${sock.user?.id}`);
			if (PAIR_MODE) {
				log("Link saved. Start the service now.");
				setTimeout(() => process.exit(0), 2000);
			}
		}
		if (connection === "close") {
			connected = false;
			const code = lastDisconnect?.error?.output?.statusCode;
			if (code === DisconnectReason.loggedOut) {
				rmSync(AUTH_DIR, { recursive: true, force: true }); // credentials are dead once unlinked
				log("WhatsApp logged out (device unlinked). In omp run: /whatsapp pair");
				process.exit(3);
			}
			log(`Connection closed (${code ?? lastDisconnect?.error?.message}); reconnecting…`);
			clearTimeout(reconnectTimer);
			reconnectTimer = setTimeout(() => {
				connect().catch((err) => { log(`Reconnect failed: ${err.message}`); process.exit(1); });
			}, code === DisconnectReason.restartRequired ? 0 : 3000);
		}
	});

	if (!PAIR_MODE) sock.ev.on("messages.upsert", onUpsert);
}

/** Phone number (digits) of the sender of a 1:1 message, resolving LID addressing. */
async function senderNumber(key) {
	const jid = key.remoteJid;
	let pn = jid.endsWith("@s.whatsapp.net") ? jid : key.remoteJidAlt;
	if (!pn && jid.endsWith("@lid")) {
		pn = await sock.signalRepository?.lidMapping?.getPNForLID(jid).catch(() => null);
	}
	return pn ? pn.split("@")[0].split(":")[0] : null;
}

const warnedSenders = new Set();

// Messages are handled without waiting for the agent turn they start: a reply to an
// `ask` question, a /stop, or a follow-up must get through while the agent works.
async function onUpsert({ messages, type }) {
	if (type !== "notify") return;
	for (const msg of messages) {
		try {
			await onMessage(msg);
		} catch (err) {
			log("failed to handle message:", err);
			await reply(`Failed: ${err.message}`).catch(() => {});
		}
	}
}

async function onMessage(msg) {
	const { key, message } = msg;
	if (!message || key.fromMe) return;
	const jid = key.remoteJid;
	if (!jid || !(jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid"))) return; // groups, status, newsletters
	if (Number(msg.messageTimestamp) < Date.now() / 1000 - MAX_MESSAGE_AGE_S) return;

	const number = await senderNumber(key);
	if (!number || !settings.allowedNumbers.has(number)) {
		const who = number ?? jid;
		if (!warnedSenders.has(who)) {
			warnedSenders.add(who);
			log(`ignored message from ${who} (not in allowedNumbers)`);
		}
		return;
	}

	activeJid = jid;
	await sock.readMessages([key]);

	const text = (
		message.conversation ||
		message.extendedTextMessage?.text ||
		message.imageMessage?.caption ||
		message.documentMessage?.caption ||
		message.documentWithCaptionMessage?.message?.documentMessage?.caption ||
		message.videoMessage?.caption ||
		""
	).trim();

	if (text.startsWith("/") && (await bridgeCommand(text))) return;
	if (pendingUi && text && !text.startsWith("/")) return answerUi(text);

	const images = [];
	const notes = [];
	const doc = message.documentMessage || message.documentWithCaptionMessage?.message?.documentMessage;
	if (message.imageMessage) {
		const data = await downloadMediaMessage(msg, "buffer", {});
		const mimeType = message.imageMessage.mimetype || "image/jpeg";
		const path = join(INBOX_DIR, `${Date.now()}-image${MIME_EXT[mimeType] ?? ".jpg"}`);
		writeFileSync(path, data, { mode: 0o600 });
		images.push({ type: "image", data: data.toString("base64"), mimeType });
		notes.push(`[Image from the user, also saved at ${path}]`);
	} else if (doc) {
		const data = await downloadMediaMessage(msg, "buffer", {});
		const name = basename(doc.fileName || `file-${key.id}`).replace(/[^\w.\- ]/g, "_");
		const path = join(INBOX_DIR, `${Date.now()}-${name}`);
		writeFileSync(path, data, { mode: 0o600 });
		notes.push(`[File from the user saved at ${path} (${doc.mimetype || "unknown"}, ${data.length} bytes)]`);
	} else if (message.audioMessage || message.videoMessage || message.stickerMessage) {
		return reply("Voice notes, videos, and stickers are not supported yet. Send text, images, or documents.");
	}

	const prompt = [notes.join("\n"), text].filter(Boolean).join("\n\n");
	if (!prompt && !images.length) return;

	if (prompt.startsWith("/")) {
		const name = prompt.slice(1).split(/\s/, 1)[0];
		if (!agent.commands.has(name)) {
			return reply(`/${name} is not available over WhatsApp (omp RPC mode). Send /help.`);
		}
	}
	submit(key, prompt, images);
}

// ---------------------------------------------------------------------------
// Prompts

let inFlight = 0; // prompts submitted to omp and not yet yielded
let nameSession = false; // fresh session: title it from the first message

function submit(key, prompt, images) {
	react(key, "⏳");
	inFlight++;
	const first = nameSession && !prompt.startsWith("/");
	if (first) nameSession = false;
	agent
		.prompt(prompt, images.length ? images : undefined)
		.catch((err) => ({ status: "error", error: { message: err.message } }))
		.then(async (result) => {
			if (first) {
				const title = `WA: ${prompt.replace(/\s+/g, " ").slice(0, 60)}`;
				await agent.request({ type: "set_session_name", name: title }).catch(() => {});
			}
			if (result.status === "error") {
				await reply(`Failed: ${result.error?.message ?? "unknown error"}`);
				await react(key, "❌");
			} else {
				await react(key, result.status === "aborted" ? "⏹️" : "✅");
			}
		})
		.finally(() => {
			inFlight--;
			applyPendingRestart();
		})
		.catch((err) => log("failed to finish prompt:", err));
}

// ---------------------------------------------------------------------------
// Bridge commands (omp has no RPC equivalent for these)

/** @returns {Promise<boolean>} true when the message was a bridge command */
async function bridgeCommand(text) {
	const [cmd, ...rest] = text.slice(1).split(/\s+/);
	const arg = rest.join(" ").trim();
	switch (cmd.toLowerCase()) {
		case "help":
			await reply(HELP);
			return true;
		case "stop":
			if (pendingUi) cancelUi();
			progress.stop();
			await agent.request({ type: "abort" }).catch(() => {});
			await reply("Stopped.");
			return true;
		case "new":
			if (pendingUi) cancelUi();
			await agent.request({ type: "new_session" });
			await agent.refreshSession();
			nameSession = true;
			await reply(`New session in ${tildify(agent.opts.cwd)}.`);
			return true;
		case "status":
			await reply(await statusText());
			return true;
		case "cd":
			await changeProject(arg);
			return true;
		case "resume":
			await resumeSession(arg);
			return true;
		default:
			return false;
	}
}

async function statusText() {
	const s = await agent.request({ type: "get_state" });
	const ctx = s.contextUsage;
	return [
		`Project: ${tildify(agent.opts.cwd)}`,
		`Session: ${s.sessionName ?? "(untitled)"}${s.messageCount ? ` — ${s.messageCount} messages` : ""}`,
		`Model: ${s.model?.provider}/${s.model?.id} (thinking ${s.thinkingLevel})`,
		`Working: ${s.isStreaming ? "yes" : "no"}${s.queuedMessageCount ? `, ${s.queuedMessageCount} queued` : ""}`,
		pendingUi ? "Waiting for your answer to the agent's question." : null,
		ctx ? `Context: ${ctx.tokens}/${ctx.contextWindow} tokens (${Number(ctx.percent).toFixed(1)}%)` : null,
	]
		.filter(Boolean)
		.join("\n");
}

async function changeProject(arg) {
	if (!arg) return reply(`Current project: ${tildify(agent.opts.cwd)}\nUsage: /cd <folder-name | path>`);
	const found = resolveProject(arg);
	if (found.error) return reply(found.error);
	if (found.candidates) {
		return reply(`Several folders match; use a full path:\n${found.candidates.map(tildify).join("\n")}`);
	}
	if (inFlight > 0) return reply("The agent is still working. Wait for it to finish or /stop first.");
	switchProject(found.dir);
	await reply(`Switched to ${tildify(found.dir)}. New session started.`);
}

/** Restart omp in `dir` with a fresh session. */
function switchProject(dir) {
	if (pendingUi) cancelUi();
	state = { cwd: dir };
	saveState();
	Object.assign(agent.opts, { cwd: dir, sessionFile: undefined });
	nameSession = true;
	agent.restart();
}

let lastListing = [];

async function resumeSession(arg) {
	if (!arg) {
		lastListing = listSessions(agent.opts.sessionFile);
		if (!lastListing.length) return reply("No saved sessions for this project yet.");
		const lines = lastListing.map((s, i) => {
			const current = s.file === agent.opts.sessionFile ? " ← active" : "";
			return `${i + 1}. ${s.title ?? basename(s.file).slice(0, 19)} — ${ago(s.mtime)}${current}`;
		});
		return reply(`*Sessions in ${tildify(agent.opts.cwd)}*\n${lines.join("\n")}\n\nReply /resume <n>.`);
	}
	const pick = lastListing[Number(arg) - 1];
	if (!pick) return reply("Invalid number. Run /resume first to see the list.");
	if (inFlight > 0) return reply("The agent is still working. Wait for it to finish or /stop first.");
	if (pendingUi) cancelUi();
	await agent.request({ type: "switch_session", sessionPath: pick.file });
	await agent.refreshSession();
	const warn =
		Date.now() - pick.mtime.getTime() < 5 * 60 * 1000
			? "\nThis session was active recently; don't use it from the terminal at the same time."
			: "";
	await reply(`Resumed: ${pick.title ?? basename(pick.file)}${warn}`);
}

// ---------------------------------------------------------------------------
// Agent dialogs (ask tool, command pickers) relayed to WhatsApp

let pendingUi = null; // extension_ui_request awaiting the user's reply
let uiStash = null; // free text meant for the editor that follows an "Other" pick

function onUiRequest(frame) {
	if (uiStash !== null && (frame.method === "editor" || frame.method === "input")) {
		const value = uiStash;
		uiStash = null;
		agent.respondUi(frame.id, { value });
		return;
	}
	pendingUi = frame;
	if (frame.timeout) {
		// omp answers with the default itself when the dialog times out
		setTimeout(() => {
			if (pendingUi === frame) pendingUi = null;
		}, frame.timeout);
	}
	const title = frame.title ? `*${frame.title}*` : "*Question from the agent*";
	const body = frame.message ? `\n${frame.message}` : "";
	let prompt;
	switch (frame.method) {
		case "select":
			prompt = `${frame.options
				.map((o, i) => `${i + 1}. ${o}${frame.optionDetails?.[i]?.description ? ` — ${frame.optionDetails[i].description}` : ""}`)
				.join("\n")}\n\nReply with a number, or type your own answer.`;
			break;
		case "confirm":
			prompt = "Reply *yes* or *no*.";
			break;
		default:
			prompt = frame.placeholder ? `Type your answer (${frame.placeholder}).` : "Type your answer.";
	}
	reply(`❓ ${title}${body}\n${prompt}`).catch((err) => log("failed to send question:", err));
}

function answerUi(text) {
	const frame = pendingUi;
	pendingUi = null;
	if (frame.method === "confirm") {
		const yes = /^(y|ya|yes|ok|oke|iya|lanjut|setuju)\b/i.test(text);
		const no = /^(n|no|tidak|tdk|gak|nggak|batal|jangan)\b/i.test(text);
		if (!yes && !no) {
			pendingUi = frame;
			return reply("Reply *yes* or *no*.");
		}
		return agent.respondUi(frame.id, { confirmed: yes });
	}
	if (frame.method === "select") {
		const n = Number(text);
		const byNumber = Number.isInteger(n) ? frame.options[n - 1] : undefined;
		const byLabel = frame.options.find((o) => o.toLowerCase() === text.toLowerCase());
		const choice = byNumber ?? byLabel;
		if (choice) return agent.respondUi(frame.id, { value: choice });
		const other = frame.options.find((o) => /^other\b/i.test(o));
		if (other) {
			uiStash = text; // omp asks for the custom text next
			return agent.respondUi(frame.id, { value: other });
		}
		pendingUi = frame;
		return reply(`Pick a number from 1 to ${frame.options.length}.`);
	}
	return agent.respondUi(frame.id, { value: text });
}

function cancelUi() {
	const frame = pendingUi;
	pendingUi = null;
	uiStash = null;
	try {
		agent.respondUi(frame.id, { cancelled: true });
	} catch {
		// omp already gone; nothing to answer
	}
}

// ---------------------------------------------------------------------------
// Progress: a "typing…" presence heartbeat while the agent works

const progress = createProgress({
	host: {
		sendPresenceUpdate: (state) => {
			if (activeJid) sock?.sendPresenceUpdate(state, activeJid).catch(() => {});
		},
	},
});

// ---------------------------------------------------------------------------
// Outgoing

// A turn that only calls tools can carry placeholder punctuation (".") as its
// text. It carries no information, so it must not become a WhatsApp bubble.
// Letters, digits, symbols and emoji all pass.
const NO_CONTENT = /^[\p{P}\p{Z}\p{C}]+$/u;

async function reply(text) {
	if (!activeJid) return;
	for (const part of chunk(toWhatsApp(text))) await sock.sendMessage(activeJid, { text: part });
}

async function react(key, emoji) {
	await sock.sendMessage(key.remoteJid, { react: { text: emoji, key } }).catch(() => {});
}

async function sendFile({ path, caption }) {
	if (!activeJid) throw new Error("No active WhatsApp chat");
	const size = statSync(path).size;
	if (size > MAX_SEND_BYTES) throw new Error(`File too large: ${size} bytes (max ${MAX_SEND_BYTES})`);
	const data = readFileSync(path);
	const ext = extname(path).toLowerCase();
	const content = IMAGE_EXT.has(ext)
		? { image: data, caption }
		: { document: data, fileName: basename(path), mimetype: "application/octet-stream", caption };
	await sock.sendMessage(activeJid, content);
	return `Sent ${basename(path)} (${size} bytes) to WhatsApp.`;
}

// ---------------------------------------------------------------------------
// omp agent

function startAgent() {
	agent = new OmpAgent({
		bin: env.OMP_BIN || "omp",
		args: ["--approval-mode", "yolo", "--append-system-prompt", SYSTEM_APPEND],
		hostTools: HOST_TOOLS,
		onHostTool: async (name, args) => {
			if (name === "whatsapp_send_file") return sendFile(args);
			throw new Error(`Unknown host tool: ${name}`);
		},
		cwd: state.cwd || settings.cwd,
		sessionFile: state.sessionFile,
		model: settings.model,
		thinking: settings.thinking,
	});
	agent.on("log", (line) => log(line));
	agent.on("exit", (err, restarting) => {
		if (pendingUi) pendingUi = null; // the dialog died with the process
		log(`${err.message}; ${restarting ? "restarting with new settings" : "restarting in 3s"}`);
	});
	agent.on("initialized", () =>
		log(`omp ready (cwd=${agent.opts.cwd}, model=${agent.opts.model || "default"}, thinking=${agent.opts.thinking})`),
	);
	agent.on("session", (s) => {
		state = { cwd: agent.opts.cwd, sessionFile: s.sessionFile };
		saveState();
		if (!s.messageCount && !s.sessionName) nameSession = true;
	});
	agent.on("assistant_text", (text) => {
		if (NO_CONTENT.test(text)) return;
		reply(text).catch((err) => log("failed to send reply:", err));
	});
	agent.on("command_output", (text) => reply(text).catch((err) => log("failed to send command output:", err)));
	agent.on("notify", (text, level) => reply(`${level === "error" ? "⚠️ " : ""}${text}`).catch(() => {}));
	agent.on("ui_request", onUiRequest);
	agent.on("agent_start", () => {
		if (settings.progress === "tools") progress.start();
	});
	agent.on("agent_end", () => progress.stop());
	agent.start();
}

// Settings edited through `omp plugin config`, /whatsapp set, or /settings land in
// omp's plugin lockfile. The allowlist and progress apply immediately; model and
// thinking restart omp (same session) once idle; a new default cwd switches project.
let pendingRestart = null; // null | "restart" | {cwd}

function applyPendingRestart() {
	if (!pendingRestart || inFlight > 0) return;
	const action = pendingRestart;
	pendingRestart = null;
	Object.assign(agent.opts, { model: settings.model, thinking: settings.thinking });
	if (action.cwd) switchProject(action.cwd);
	else agent.restart();
}

function watchSettings() {
	const file = lockfilePath();
	let timer = null;
	watch(dirname(file), (_event, name) => {
		if (name !== basename(file)) return;
		clearTimeout(timer);
		timer = setTimeout(() => {
			const prev = settings;
			settings = loadSettings();
			const allow = [...settings.allowedNumbers].join(",");
			if (allow !== [...prev.allowedNumbers].join(",")) {
				log(`allowedNumbers updated: ${allow || "(empty)"}`);
				warnedSenders.clear();
			}
			if (settings.cwd !== prev.cwd) pendingRestart = { cwd: settings.cwd };
			else if (settings.model !== prev.model || settings.thinking !== prev.thinking) pendingRestart ??= "restart";
			else return;
			log("agent settings changed; applying once the agent is idle");
			applyPendingRestart();
		}, 300);
	});
}

if (!PAIR_MODE) {
	stopNotifications = await startNotifications(sendReport, () => {
		log("Notification server failed");
		process.exit(1);
	});
	process.on("exit", () => stopNotifications?.());
	if (!settings.allowedNumbers.size) {
		log("allowedNumbers is empty: all messages are ignored. Set it with: /whatsapp set allowedNumbers 628xxx");
	}
	startAgent();
	watchSettings();
	for (const sig of ["SIGINT", "SIGTERM"]) {
		process.on(sig, () => {
			if (shuttingDown) return;
			shuttingDown = true;
			connected = false;
			clearTimeout(reconnectTimer);
			stopNotifications?.();
			stopNotifications = null;
			agent.stop();
			setTimeout(() => process.exit(0), 1500);
		});
	}
}
try { await connect(); }
catch (err) { log(`WhatsApp startup failed: ${err.message}`); process.exit(1); }
