// Usage: node src/send-report.js /absolute/path/to/report.txt
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";
import { MAX_REPORT_BYTES, sendNotification } from "./notifications.js";

async function main() {
	const [file, ...extra] = process.argv.slice(2);
	if (!file || extra.length || !isAbsolute(file)) throw new Error("Usage: node src/send-report.js ABSOLUTE_REPORT_TEXT_PATH");
	const handle = await open(file, "r");
	let text;
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) throw new Error("Report must be a regular UTF-8 file no larger than 64 KiB");
		const bytes = Buffer.alloc(MAX_REPORT_BYTES + 1);
		let size = 0;
		while (size < bytes.length) {
			const result = await handle.read(bytes, size, bytes.length - size, null);
			if (!result.bytesRead) break;
			size += result.bytesRead;
		}
		if (size > MAX_REPORT_BYTES) throw new Error("Report is larger than 64 KiB");
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
		if (!text.trim()) throw new Error("Report is empty");
	} finally { await handle.close(); }
	await sendNotification(text);
	console.log("Report sent");
}

main().catch((err) => {
	console.error(`Report failed: ${err.message}`);
	process.exitCode = 1;
});
