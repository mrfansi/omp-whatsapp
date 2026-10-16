// Bridge settings live in omp's plugin runtime config (the same store edited by
// `omp plugin config` and the /settings → Plugins overlay). Defaults come from
// the `omp.settings` schema in package.json.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_NAME = "omp-whatsapp";
export const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
export const STATE_DIR = process.env.WA_STATE_DIR || join(homedir(), ".local/share/omp-whatsapp");
export const AUTH_DIR = join(STATE_DIR, "auth");
export const SERVICE = "omp-whatsapp.service";

const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")).omp;

/** omp's user plugin root: `$XDG_DATA_HOME/omp/plugins` once `omp config init-xdg` ran, else `~/.omp/plugins`. */
export function pluginsDir() {
	const xdg = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "omp/plugins");
	return existsSync(join(xdg, "omp-plugins.lock.json")) ? xdg : join(homedir(), ".omp/plugins");
}

export const lockfilePath = () => join(pluginsDir(), "omp-plugins.lock.json");

/**
 * Effective settings: persisted value, else schema default.
 * @returns {{allowedNumbers: Set<string>, cwd: string, model: string, thinking: string, progress: string, notifications: string}}
 */
export function loadSettings() {
	let stored = {};
	try {
		stored = JSON.parse(readFileSync(lockfilePath(), "utf8")).settings?.[PLUGIN_NAME] ?? {};
	} catch {
		// Missing or mid-write lockfile: fall back to defaults.
	}
	const value = (key) => stored[key] ?? manifest.settings[key].default;
	return {
		allowedNumbers: new Set(
			String(value("allowedNumbers"))
				.split(",")
				.map((n) => n.replace(/\D/g, ""))
				.filter(Boolean),
		),
		cwd: String(value("cwd")).trim().replace(/^~(?=\/|$)/, homedir()) || homedir(),
		model: String(value("model")).trim(),
		thinking: value("thinking"),
		progress: value("progress"),
		notifications: value("notifications"),
	};
}
