# omp-whatsapp

Use omp from WhatsApp the same way you use it in the terminal. The package has two parts:

- **omp plugin** (`src/extension.js`): adds the `/whatsapp` command and settings to omp.
- **Bridge service** (`src/index.js`, systemd user unit): links one WhatsApp account through Baileys
  (WhatsApp Web multi-device) and relays 1:1 chats from allowlisted numbers to an
  `omp --mode rpc-ui` session. It runs outside omp so WhatsApp stays reachable when no omp window is open.

The bridge session loads your normal omp setup: skills, MCP servers, memory, extensions,
model roles, and slash commands. Sessions are stored in omp's default session store for the
project folder, so `omp --resume` in the terminal lists WhatsApp sessions and `/resume` on
WhatsApp lists terminal sessions.

The agent runs with `--approval-mode yolo`, so every tool (bash, edit, MCP) runs without
confirmation. Access control is only `allowedNumbers` plus physical access to that phone.
Baileys is unofficial, so use a dedicated number, not your main one (Meta may ban it).

## Setup

```sh
npm install
omp plugin link .                                   # registers /whatsapp and the settings
cp systemd/omp-whatsapp.service ~/.config/systemd/user/ && systemctl --user daemon-reload
```

Then in omp:

```
/whatsapp set allowedNumbers 628xxxxxxxxxx          # your own number(s), comma-separated
/whatsapp set cwd ~/Github/viding-co                # default project (optional)
/whatsapp pair                                      # QR panel; scan it from the bot phone
/whatsapp status
```

`/whatsapp pair` stops the service, clears any unfinished attempt, and shows a QR panel in place of
the editor (WhatsApp → Linked devices → Link a device). The QR refreshes by itself; Esc cancels.
Once linked, the service starts. The panel needs the omp terminal UI and a terminal at least ~62
columns wide. `/whatsapp pair <bot-number>` shows a pairing code instead (Link with phone number),
and `npm run pair` prints the QR in a plain terminal.

`loginctl enable-linger mrfansi` keeps the user service running without a login session.

## Settings

Stored in omp's plugin config. Edit them with `/whatsapp set <key> <value>`, `/settings` →
Plugins, or `omp plugin config set omp-whatsapp <key> <value>`. The bridge reloads them live.

| Key | Effect |
| --- | --- |
| `allowedNumbers` | Numbers allowed to command the agent. Applies immediately. |
| `cwd` | Default project. Changing it switches the bridge there with a new session. |
| `model` | `provider/id` override; empty uses your omp default role. Applied on idle, same session. |
| `thinking` | Thinking level override (`default` = omp's). Applied on idle, same session. |
| `progress` | `tools`: show a "typing…" indicator while the agent works; `off` (default): none. WhatsApp cannot live-edit a sent message, so this never sends progress messages. |
| `notifications` | `terminal`: send status and the final assistant answer when terminal-main work ends; `off` (default): disabled. Read live at completion. |

`/whatsapp start|stop|restart|logs` control the service. `stop` also disables autostart.

## Using it from WhatsApp

- Plain messages are prompts. Messages sent while the agent works are queued as follow-ups.
- omp slash commands work as in the terminal wherever omp's RPC mode supports them: `/model`,
  `/switch`, `/compact`, `/todo`, `/mcp`, `/rename`, `/session`, `/usage`, `/move`,
  `/skill:<name>`, and more. Unsupported ones (for example `/goal`, `/vibe`, `/btw`) are refused
  with a message instead of being sent to the model.
- Agent questions (`ask` tool, command pickers) arrive as numbered lists. Reply with a number,
  *yes*/*no* for confirmations, or free text (picks "Other" and sends your text).
- Images are attached to the prompt and saved to `~/.local/share/omp-whatsapp/inbox/`; documents
  are saved there and their path is given to the agent. Voice notes, videos, and stickers are
  not supported.
- The agent can send files back with the `whatsapp_send_file` host tool.
- Reactions on your message: ⏳ working, ✅ done, ⏹️ stopped, ❌ failed.

Bridge commands (omp has no RPC equivalent):

| Command | Effect |
| --- | --- |
| `/cd <name\|path>` | Switch project. Names are searched under `~/Github` (3 levels). Starts a new session. |
| `/new` | New session in the current project. |
| `/resume`, `/resume <n>` | List the project's sessions (terminal ones included) / continue one. Don't drive one session from the terminal and WhatsApp at the same time. |
| `/stop` | Abort the running turn and cancel a pending question. |
| `/status` | Project, session, model, context usage. |
| `/help` | Command summary. |

## Terminal completion notifications

Enable automatic reports for work performed in the terminal:

```sh
omp plugin config set omp-whatsapp notifications terminal
```

Or use `/whatsapp set notifications terminal` inside omp. Open a new terminal omp session
after updating the plugin so its completion hooks are loaded; later setting changes apply
without restarting the bridge. Disable with `/whatsapp set notifications off`.

Only the main agent in terminal (`tui`) mode sends these notifications. WhatsApp commands,
RPC/ACP, print/JSON runs, and subagents are excluded, even when their runner exposes a UI.
Automatic continuations and queued work do not send intermediate reports.

Each report contains the project/directory, elapsed time, turn status, and only the last
finalized assistant text—not the transcript, thinking, or tool output. Error, abort, and
output-limit stops are labelled explicitly; a completed turn is not proof that its task or
tests succeeded. Unusually large answers are cut with an explicit truncation marker to fit
the existing 64 KiB text and 128 KiB encoded-request limits.

Reports use the existing bridge connection and the **single** configured `allowedNumbers`
recipient, without changing the active WhatsApp chat or agent session. The service must be
running and connected. Sending is asynchronous; a busy/disconnected bridge or other delivery
failure shows a terminal warning and does not fail the completed work. There is no automatic
retry because a failure can follow partial delivery. Closing the omp session cancels any
outstanding report; allow delivery to finish before exiting.

## External text reports

With the bridge service running and connected, send an existing UTF-8 report:

```sh
node /home/mrfansi/Github/mrfansi/omp-whatsapp/src/send-report.js /absolute/path/to/report.txt
```

The CLI reads a regular file (nonempty, at most 64 KiB) and submits one newline-delimited
JSON object containing only `text` to `~/.local/share/omp-whatsapp/notify.sock`.
`WA_STATE_DIR` overrides that directory for both daemon and CLI. Encoded requests are bounded
to 128 KiB. The server never accepts file paths, destination overrides, or agent prompts.

The Unix socket is owned by the service user and restricted to mode `0600`. Startup refuses
non-socket paths, sockets owned by another user, and an already-running listener; it removes
only an owned stale socket after a refused connection. Shutdown cleans up its socket.
Access is limited to local processes running as that user, not isolated from those processes.

Reports require **exactly one** currently configured `allowedNumbers` entry; zero or multiple
numbers fail closed. The destination and live connection are checked before sending and between
chunks. Reports reuse the existing Baileys connection and Markdown/chunk formatting, without
changing the active chat, project, or agent session. No second WhatsApp login is created.

`Report sent` and exit code 0 mean all chunks completed their awaited WhatsApp sends. Malformed,
oversized, busy, disconnected, or timed-out requests exit nonzero. This is a send acknowledgement,
not proof the recipient read the message. The server has a 90-second delivery deadline and
a 10-second incomplete-request timeout. The client sends once and never retries: errors or
timeouts can occur after partial delivery, so callers must not automatically resend.


## State

`~/.local/share/omp-whatsapp/`: `auth/` (WhatsApp link credentials; secret), `state.json`
(current project and session file), `inbox/` (received files). Session transcripts live in
`~/.omp/agent/sessions/`.

If the device is unlinked from the phone, the service deletes the dead credentials and exits
with code 3 (no automatic restart); run `/whatsapp pair` again.
