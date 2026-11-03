const fs = require("node:fs/promises");
const path = require("node:path");

const RUN_FILE = "XojoRunProject.txt";
const ERROR_FILE = "XojoCompileErrors.txt";

function agenticEnabled(manifest) {
	return /^\s*AgenticMode\s*=\s*True\s*$/im.test(manifest);
}

function runMode(mode, manifest) {
	if (!["auto", "agentic", "legacy"].includes(mode)) throw new Error(`Unknown Xojo run mode: ${mode}`);
	return mode === "auto" ? agenticEnabled(manifest) ? "agentic" : "legacy" : mode;
}

async function optionalStat(file) {
	try { return await fs.stat(file); }
	catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function errorSnapshot(file) {
	try {
		const stat = await fs.stat(file);
		return { stamp: [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"), text: await fs.readFile(file, "utf8") };
	} catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/** Request an IDE run; marker consumption is an acknowledgement, not proof of compilation success. */
class XojoAgenticRunner {
	constructor() {
		this.pending = new Set();
		this.disposed = false;
	}

	async run(projectPath, options = {}) {
		const directory = await fs.realpath(path.dirname(projectPath));
		if (this.disposed) throw new Error("Xojo run support has been disposed.");
		if (this.pending.has(directory)) throw new Error("このフォルダーのXojo実行要求は処理中です。");
		this.pending.add(directory);
		try { return await this.request(directory, options); }
		finally { this.pending.delete(directory); }
	}

	async request(directory, options) {
		const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 30000;
		const errorWaitMs = Number.isFinite(options.errorWaitMs) ? Math.max(0, options.errorWaitMs) : 10000;
		const pollMs = Number.isFinite(options.pollMs) ? Math.max(1, options.pollMs) : 250;
		const cancelled = () => this.disposed || options.token?.isCancellationRequested;
		const marker = path.join(directory, RUN_FILE);
		const errorsFile = path.join(directory, ERROR_FILE);
		const baseline = await errorSnapshot(errorsFile);
		if (cancelled()) return { status: "cancelled", consumed: false };
		let owned, consumed = false;
		try {
			let handle;
			try {
				handle = await fs.open(marker, "wx");
				owned = await handle.stat();
			} catch (error) {
				if (error.code === "EEXIST") throw new Error(`${RUN_FILE}が既に存在します。Xojoでの処理状況を確認してください。`);
				throw error;
			} finally { await handle?.close(); }
			options.onStatus?.("pending");
			const deadline = Date.now() + timeoutMs;
			while (true) {
				if (cancelled()) return { status: "cancelled", consumed };
				const current = await optionalStat(marker);
				if (!current) { consumed = true; break; }
				if (current.ino !== owned.ino || current.dev !== owned.dev || current.birthtimeMs !== owned.birthtimeMs) {
					throw new Error("Xojo実行要求ファイルが別のファイルに置き換わりました。処理状況を確認してください。");
				}
				if (Date.now() >= deadline) return { status: "timeout", consumed };
				await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
			}
			options.onStatus?.("consumed");
			const observeUntil = Date.now() + errorWaitMs;
			let latest;
			do {
				if (cancelled()) return { status: "cancelled", consumed };
				latest = await errorSnapshot(errorsFile);
				// An old, untouched error file must not be attributed to this request.
				if (Date.now() >= observeUntil) break;
				await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, observeUntil - Date.now())));
			} while (true);
			const fresh = latest && (!baseline || latest.stamp !== baseline.stamp || latest.text !== baseline.text);
			return { status: "observed", consumed, errors: fresh ? latest.text : null,
				staleErrors: Boolean(latest && !fresh), errorsFile };
		} finally {
			// Never remove someone else's pending request. Consumed requests need no cleanup.
			if (owned && !consumed) {
				const current = await optionalStat(marker);
				if (current && current.ino === owned.ino && current.dev === owned.dev && current.birthtimeMs === owned.birthtimeMs) {
					try { await fs.unlink(marker); } catch (error) { if (error.code !== "ENOENT") throw error; }
				}
			}
		}
	}

	dispose() { this.disposed = true; }
}

module.exports = { RUN_FILE, ERROR_FILE, agenticEnabled, runMode, XojoAgenticRunner };
