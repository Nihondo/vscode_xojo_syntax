const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

function activate(workspaceOverrides = {}, modules = {}) {
	const registrations = {};
	const listeners = {};
	const disposable = () => ({ dispose() {} });
	const event = name => listener => { listeners[name] = listener; return disposable(); };
	class Position { constructor(line, character) { Object.assign(this, { line, character }); } }
	class Range { constructor(start, end) { Object.assign(this, { start, end }); } }
	class Location { constructor(uri, range) { Object.assign(this, { uri, range }); } }
	class SymbolInformation { constructor(name, kind, containerName, location) { Object.assign(this, { name, kind, containerName, location }); } }
	class DocumentSymbol {
		constructor(name, detail, kind, range, selectionRange) { Object.assign(this, { name, detail, kind, range, selectionRange, children: [] }); }
	}
	class FoldingRange { constructor(start, end) { Object.assign(this, { start, end }); } }
	class Color { constructor(red, green, blue, alpha) { Object.assign(this, { red, green, blue, alpha }); } }
	class ColorInformation { constructor(range, color) { Object.assign(this, { range, color }); } }
	class ColorPresentation { constructor(label) { this.label = label; } }
	const vscode = {
		Position, Range, Location, SymbolInformation, DocumentSymbol, FoldingRange, Color, ColorInformation, ColorPresentation,
		TextEdit: { replace: (range, newText) => ({ range, newText }) },
		SymbolKind: new Proxy({}, { get: (_, name) => name }),
		workspace: {
			registerTextDocumentContentProvider: (scheme, provider) => { registrations.content = { scheme, provider }; return disposable(); },
			textDocuments: [], findFiles: async()=>[], fs: {readFile:async()=>Buffer.from('')},
			createFileSystemWatcher: pattern => { registrations.watchPattern = pattern; return {onDidCreate:event('create'),onDidChange:event('change'),onDidDelete:event('delete'),dispose(){}}; },
			onDidSaveTextDocument:event('save'), onDidChangeWorkspaceFolders:event('roots'), onDidChangeConfiguration:event('configuration'),
			...workspaceOverrides,
		},
		commands: { registerCommand: (name, callback) => { (registrations.commands ||= {})[name] = callback; return disposable(); } },
		debug: { registerDebugConfigurationProvider: (type, provider) => { registrations.debug = provider; return disposable(); } },
		languages: Object.fromEntries(['DocumentSymbol', 'FoldingRange', 'Color'].map(name => ['register' + name + 'Provider', (selector, provider) => { registrations[name] = { selector, provider }; return disposable(); }])),
	};
	vscode.languages.registerWorkspaceSymbolProvider = provider => { registrations.WorkspaceSymbol = provider; return disposable(); };
	const file = path.join(__dirname, '../extension.js');
	const realRequire = createRequire(file);
	const context = { module: { exports: {} }, require: name => name === 'vscode' ? vscode : modules[name] || realRequire(name), process, Buffer };
	vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
	context.module.exports.activate({ subscriptions: [] });
	return { ...registrations, listeners };
}

function document(text, scheme, name) {
	return { text, version: 1, languageId: 'xojo', uri: { scheme, path: '/' + name, toString:()=>`${scheme}:///${name}` }, fileName: name,
		getText(range) { return range ? this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end)) : this.text; },
		offsetAt(position) { const lines = this.text.split(/(?<=\n)|(?<=\r)(?!\n)/); return lines.slice(0, position.line).join('').length + position.character; },
		positionAt(offset) { const parts = this.text.slice(0, offset).split(/\r\n|\r|\n/); return { line: parts.length - 1, character: parts.at(-1).length }; },
	};
}

test("Outline and folding register for file, untitled and library API documents", () => {
	const registration = activate();
	for (const scheme of ['file', 'untitled', 'xojo-library']) {
		const doc = document('#tag Enum, Name = Level\nOne\nTwo\n#tag EndEnum', scheme, scheme === 'untitled' ? 'Untitled-1' : 'Level.xojo_code');
		for (const kind of ['DocumentSymbol', 'FoldingRange']) assert.ok(registration[kind].selector.some(s => s.scheme === scheme && s.language === 'xojo'));
		const symbols = registration.DocumentSymbol.provider.provideDocumentSymbols(doc);
		assert.equal(symbols[0].name, 'Level');
		assert.deepEqual(Array.from(symbols[0].children, s => s.name), ['One', 'Two']);
		assert.equal(symbols[0].selectionRange.start.character, 18);
		const ranges = registration.FoldingRange.provider.provideFoldingRanges(doc);
		assert.equal(ranges[0].start, 0);
		assert.equal(ranges[0].end, 2);
	}
	assert.equal(registration.content.scheme, 'xojo-library');
});

test("document version changes invalidate the shared analysis", () => {
	const registration = activate();
	const doc = document('Sub Before()\nEnd Sub', 'untitled', 'Untitled-1');
	assert.equal(registration.DocumentSymbol.provider.provideDocumentSymbols(doc)[0].name, 'Before');
	doc.text = 'Sub After()\nReturn\nEnd Sub';
	doc.version++;
	assert.equal(registration.DocumentSymbol.provider.provideDocumentSymbols(doc)[0].name, 'After');
	assert.equal(registration.FoldingRange.provider.provideFoldingRanges(doc)[0].end, 1);
});

test("color previews and picker replacements use Xojo notation on writable documents", () => {
	const { selector, provider } = activate().Color;
	for (const scheme of ['file', 'untitled', 'xojo-library']) assert.ok(selector.some(s => s.scheme === scheme && s.language === 'xojo'));
	for (const scheme of ['file', 'untitled']) {
		const doc = document('Var red As Color = &c FF 00 00', scheme, 'Colors.xojo_script');
		const [info] = provider.provideDocumentColors(doc);
		assert.equal(doc.getText(info.range), '&c FF 00 00');
		assert.equal(info.color.red, 1);
		assert.equal(info.color.alpha, 1);
		const [presentation] = provider.provideColorPresentations({ red: 0, green: 1, blue: 0, alpha: 0.5 }, { document: doc, range: info.range });
		assert.equal(presentation.label, '&c 00 FF 00 80');
		assert.equal(presentation.textEdit.newText, presentation.label);
		assert.equal(presentation.textEdit.range, info.range);
		doc.text = 'Var blue As Color = &c0000FFFF'; doc.version++;
		assert.equal(provider.provideDocumentColors(doc)[0].color.alpha, 0);
	}
});

test("library API colors can be previewed but do not offer edits", () => {
	const provider = activate().Color.provider;
	const doc = document('BackgroundColor = &cFF0000', 'xojo-library', 'Window.xojo_window');
	const [info] = provider.provideDocumentColors(doc);
	assert.equal(info.color.red, 1);
	assert.equal(provider.provideColorPresentations(info.color, { document: doc, range: info.range }).length, 0);
});

test("workspace provider returns declaration locations and wires cache invalidation events", async () => {
	const doc = document('Class Demo\nSub FetchCredential()\nEnd Sub\nEnd Class', 'untitled', 'Untitled-1');
	let finds = 0;
	const registration = activate({ textDocuments:[doc], findFiles:async()=>{ finds++; return []; } });
	const provider = registration.WorkspaceSymbol;
	const [symbol] = await provider.provideWorkspaceSymbols('fch');
	assert.equal(symbol.name, 'FetchCredential');
	assert.equal(symbol.containerName, 'Demo');
	assert.equal(symbol.location.uri, doc.uri);
	assert.equal(symbol.location.range.start.line, 1);
	assert.equal(symbol.location.range.start.character, 4);
	assert.ok(!((await provider.provideWorkspaceSymbols('')).some(s=>s.name==='Methods')));
	assert.equal(finds, 1);
	registration.listeners.create(); await provider.provideWorkspaceSymbols('');
	registration.listeners.configuration({affectsConfiguration:name=>name==='files.exclude'}); await provider.provideWorkspaceSymbols('');
	registration.listeners.roots(); await provider.provideWorkspaceSymbols('');
	assert.equal(finds, 4);
	assert.equal(registration.watchPattern, '**/*');
	assert.ok(require('../package.json').activationEvents.some(event=>event.startsWith('workspaceContains:')));
});

test("command and F5 share run routing and forward explicit project/mode and legacy options", async () => {
	const runs = [];
	class XojoRunController {
		run(options) { runs.push(options); }
		dispose() {}
	}
	const registration = activate({}, { './src/xojoRun': { XojoRunController } });
	await registration.commands['xojo.reloadAndRun']();
	assert.equal(runs[0], undefined);
	const folder = { uri: { scheme: 'file', fsPath: '/workspace/second' } };
	const config = { type: 'xojo', request: 'launch', runMode: 'agentic', projectPath: 'App.xojo_project',
		openProject: false, reloadDialogDelayMs: 125, reloadToRunDelayMs: 250, agenticTimeoutMs: 45000, agenticErrorWaitMs: 5000 };
	assert.equal(await registration.debug.resolveDebugConfiguration(folder, config), null);
	assert.equal(runs[1].folderUri, folder.uri);
	for (const key of ['runMode', 'projectPath', 'openProject', 'reloadDialogDelayMs', 'reloadToRunDelayMs', 'agenticTimeoutMs', 'agenticErrorWaitMs']) {
		assert.equal(runs[1][key], config[key]);
	}
	await registration.debug.resolveDebugConfiguration(undefined, {});
	assert.equal(runs[2].runMode, undefined); // Respect the workspace run mode, including in default launches.
	assert.equal(registration.debug.provideDebugConfigurations()[0].agenticErrorWaitMs, 10000);
	const manifest = require('../package.json');
	assert.equal(manifest.contributes.configuration.properties['xojo.run.mode'].default, 'auto');
	assert.ok(manifest.contributes.debuggers[0].configurationAttributes.launch.properties.projectPath);
});
