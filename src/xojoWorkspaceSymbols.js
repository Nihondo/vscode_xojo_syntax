const { scanXojoSource, getXojoDocumentKind, buildXojoOutline } = require("./xojoSyntax");

const XOJO_SOURCE_GLOB = "**/*.{xojo_code,xojo_script,xojo_window,xojo_menu}";
const isSourcePath = path => /\.xojo_(?:code|script|window|menu)$/i.test(path);

function sourcePosition(analysis, offset) {
	let low = 0, high = analysis.lines.length;
	while (low + 1 < high) {
		const middle = (low + high) >>> 1;
		if (analysis.lines[middle].start <= offset) low = middle;
		else high = middle;
	}
	return { line: low, character: offset - analysis.lines[low].start };
}

/** Flatten real symbols while retaining semantic containers, not Outline group labels. */
function collectWorkspaceSymbols(analysis, filePath) {
	const symbols = [];
	const visit = (nodes, containerName = "") => {
		for (const node of nodes) {
			if (node.isGroup) { visit(node.children, containerName); continue; }
			symbols.push({ name: node.name, kind: node.kind, containerName,
				range: { start: sourcePosition(analysis, node.selectionStart), end: sourcePosition(analysis, node.selectionEnd) } });
			visit(node.children, containerName ? `${containerName}.${node.name}` : node.name);
		}
	};
	visit(buildXojoOutline(analysis, getXojoDocumentKind(analysis, filePath)));
	return symbols;
}

function matchesQuery(name, query) {
	const candidate = name.toLowerCase();
	let offset = 0;
	for (const character of query.trim().toLowerCase()) {
		offset = candidate.indexOf(character, offset);
		if (offset < 0) return false;
		offset += character.length;
	}
	return true;
}

/** Lazy disk index with versioned open-document overlays; no editor or VS Code type dependency. */
class XojoWorkspaceIndex {
	constructor(workspace, analyzeDocument = document => scanXojoSource(document.getText())) {
		this.workspace = workspace;
		this.analyzeDocument = analyzeDocument;
		this.records = new Map();
		this.removed = new Set();
		this.openRecords = new WeakMap();
		this.discoveryVersion = 0;
		this.scannedVersion = -1;
		this.discovery = null;
		this.isDisposed = false;
	}

	rediscover() { this.discoveryVersion++; }

	reset() {
		this.records.clear();
		this.rediscover();
	}

	invalidate(uri) {
		const record = this.records.get(uri.toString());
		if (record) { record.revision++; record.symbols = null; }
		else if (isSourcePath(uri.path)) this.rediscover();
	}

	remove(uri) {
		const key = uri.toString();
		this.removed.add(key);
		const prefix = key.replace(/\/$/, "") + "/";
		for (const candidate of this.records.keys()) {
			if (candidate === key || candidate.startsWith(prefix)) this.records.delete(candidate);
		}
		this.rediscover();
	}

	async discover(token) {
		while (!this.isDisposed && this.scannedVersion !== this.discoveryVersion) {
			if (token?.isCancellationRequested) return;
			const version = this.discoveryVersion;
			if (!this.discovery || this.discovery.version !== version) {
				const task = { version };
				task.promise = (async () => {
					// A shared discovery can finish even when its initiating query is canceled.
					const uris = await this.workspace.findFiles(XOJO_SOURCE_GLOB);
					if (this.isDisposed || this.discoveryVersion !== version) return;
					const next = new Map();
					for (const uri of uris.sort((a, b) => a.toString().localeCompare(b.toString()))) {
						const key = uri.toString();
						next.set(key, this.records.get(key) || { uri, revision: 0, symbols: null, loading: null });
					}
					this.records = next;
					this.scannedVersion = version;
				})().finally(() => { if (this.discovery === task) this.discovery = null; });
				this.discovery = task;
			}
			await this.discovery.promise;
		}
	}

	async load(record) {
		if (record.loading) return record.loading;
		const revision = record.revision;
		const key = record.uri.toString();
		const task = (async () => {
			try {
				const bytes = await this.workspace.fs.readFile(record.uri);
				const analysis = scanXojoSource(Buffer.from(bytes).toString("utf8"));
				const symbols = collectWorkspaceSymbols(analysis, record.uri.path);
				if (!this.isDisposed && this.records.get(key) === record && record.revision === revision) record.symbols = symbols;
			} catch {
				// An unreadable or deleted file must not fail the entire query. Retry next time.
			}
		})().finally(() => { if (record.loading === task) record.loading = null; });
		record.loading = task;
		return task;
	}

	canIndexDocument(document) {
		if (document.isClosed) return false;
		const key = document.uri.toString();
		if (this.records.has(key)) return true;
		// VS Code can retain a saved model after its editor closes and its file is renamed.
		// Keep genuinely unsaved text recoverable, but do not resurrect stale saved models.
		if (!document.isDirty && [...this.removed].some(removed => key === removed || key.startsWith(removed.replace(/\/$/, "") + "/"))) return false;
		return document.languageId === "xojo" && ["file", "untitled", "xojo-library"].includes(document.uri.scheme);
	}

	async search(query, token) {
		if (this.isDisposed || token?.isCancellationRequested) return [];
		try { await this.discover(token); } catch { /* Keep open documents available if discovery fails. */ }
		if (this.isDisposed || token?.isCancellationRequested) return [];
		const openKeys = new Set(this.workspace.textDocuments.filter(doc => this.canIndexDocument(doc)).map(doc => doc.uri.toString()));
		const dirty = [...this.records.values()].filter(record => !record.symbols && !openKeys.has(record.uri.toString()));
		let next = 0;
		await Promise.all(Array.from({ length: Math.min(4, dirty.length) }, async () => {
			while (!this.isDisposed && !token?.isCancellationRequested && next < dirty.length) await this.load(dirty[next++]);
		}));
		if (this.isDisposed || token?.isCancellationRequested) return [];
		const entries = new Map([...this.records].map(([key, record]) => [key, { uri: record.uri, symbols: record.symbols || [] }]));
		for (const document of this.workspace.textDocuments) {
			if (!this.canIndexDocument(document)) continue;
			let cached = this.openRecords.get(document);
			if (!cached || cached.version !== document.version) {
				cached = { version: document.version,
					symbols: collectWorkspaceSymbols(this.analyzeDocument(document), document.uri.path) };
				this.openRecords.set(document, cached);
			}
			entries.set(document.uri.toString(), { uri: document.uri, symbols: cached.symbols });
		}
		const result = [];
		for (const { uri, symbols } of entries.values()) {
			for (const symbol of symbols) if (matchesQuery(symbol.name, query)) result.push({ ...symbol, uri });
		}
		return result;
	}

	dispose() {
		this.isDisposed = true;
		this.reset();
		this.removed.clear();
		this.openRecords = new WeakMap();
	}
}

module.exports = { XOJO_SOURCE_GLOB, collectWorkspaceSymbols, matchesQuery, XojoWorkspaceIndex };
