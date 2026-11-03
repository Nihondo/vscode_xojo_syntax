const test = require("node:test");
const assert = require("node:assert/strict");
const { scanXojoSource } = require("../src/xojoSyntax");
const { collectWorkspaceSymbols, matchesQuery, XojoWorkspaceIndex, XOJO_SOURCE_GLOB } = require("../src/xojoWorkspaceSymbols");

const uri = (path, scheme = "file") => ({ path, scheme, toString: () => `${scheme}://${path}` });
const routine = name => `Sub ${name}()\nEnd Sub`;
const names = symbols => symbols.map(s => s.name);
function environment(initial = {}) {
	const files = new Map(Object.entries(initial));
	const reads = [], finds = [];
	const excluded = new Set();
	const workspace = { textDocuments: [], fs: {
		async readFile(resource) {
			reads.push(resource.path);
			const text = files.get(resource.path);
			if (text instanceof Error) throw text;
			if (text === undefined) throw new Error("Not found");
			return Buffer.from(text);
		},
	}, async findFiles(...args) {
		finds.push(args);
		return [...files.keys()].filter(path => !excluded.has(path)).map(path => uri(path));
	} };
	return { files, reads, finds, excluded, workspace, index: new XojoWorkspaceIndex(workspace) };
}

test("workspace models omit synthetic groups and retain containers, overloads and exact positions", () => {
	const text = '#tag Class\r\nClass C色\r\n#tag Method\r\nShared Sub FetchCredential()\r\nEnd Sub\r\n#tag EndMethod\r\n#tag Method\r\nSub FetchCredential(value As Integer)\r\nEnd Sub\r\n#tag EndMethod\r\n#tag Property\r\nName As String\r\n#tag EndProperty\r\nEnd Class\r\n#tag EndClass';
	const symbols = collectWorkspaceSymbols(scanXojoSource(text), 'Example.xojo_code');
	assert.deepEqual(names(symbols), ['C色', 'FetchCredential', 'FetchCredential', 'Name']);
	assert.deepEqual(symbols.filter(s => s.name === 'FetchCredential').map(s => s.range.start), [{line:3,character:11},{line:7,character:4}]);
	assert.equal(symbols[1].containerName, 'C色');
	assert.equal(symbols[3].range.end.character - symbols[3].range.start.character, 4);
	const menu = collectWorkspaceSymbols(scanXojoSource('Begin Menu Methods\nBegin DesktopMenuItem Open\nEnd\nEnd'), 'Example.xojo_menu');
	assert.deepEqual(names(menu), ['Methods', 'Open']);
	assert.equal(menu[1].containerName, 'Methods');
});

test("queries use case-insensitive subsequences and empty queries include everything", () => {
	assert.ok(matchesQuery('FetchCredential', 'fCH'));
	assert.ok(matchesQuery('C結果', 'C果'));
	assert.ok(matchesQuery('Anything', ''));
	assert.ok(!matchesQuery('FetchCredential', 'dCF'));
});

test("discovery and parsing are cached across queries and changes reparse only affected files", async () => {
	const e = environment({'/one/A.xojo_code':routine('Alpha'), '/two/B.xojo_script':routine('Beta')});
	assert.deepEqual(names(await e.index.search('')), ['Alpha', 'Beta']);
	assert.deepEqual(names(await e.index.search('bt')), ['Beta']);
	assert.equal(e.finds.length, 1);
	assert.deepEqual(e.finds[0], [XOJO_SOURCE_GLOB]);
	assert.equal(e.reads.length, 2);
	e.files.set('/one/A.xojo_code', routine('Changed'));
	e.index.invalidate(uri('/one/A.xojo_code'));
	assert.deepEqual(names(await e.index.search('')), ['Changed', 'Beta']);
	assert.deepEqual(e.reads, ['/one/A.xojo_code', '/two/B.xojo_script', '/one/A.xojo_code']);
});

test("create, rename and folder deletion rediscover without reparsing unchanged files", async () => {
	const e = environment({'/one/A.xojo_code':routine('Alpha'), '/two/B.xojo_script':routine('Beta')});
	await e.index.search('');
	e.files.set('/one/C.xojo_code', routine('Created')); e.index.rediscover();
	assert.deepEqual(names(await e.index.search('')), ['Alpha', 'Created', 'Beta']);
	assert.equal(e.reads.length, 3);
	e.files.set('/two/Renamed.xojo_script', e.files.get('/two/B.xojo_script'));
	e.files.delete('/two/B.xojo_script'); e.index.remove(uri('/two/B.xojo_script'));
	const renamed = await e.index.search('Beta');
	assert.equal(renamed[0].uri.path, '/two/Renamed.xojo_script');
	e.files.delete('/one/A.xojo_code'); e.files.delete('/one/C.xojo_code'); e.index.remove(uri('/one'));
	assert.deepEqual(names(await e.index.search('')), ['Beta']);
});

test("exclusion and workspace-root changes remove old entries", async () => {
	const e = environment({'/one/A.xojo_code':routine('Alpha'), '/two/B.xojo_code':routine('Beta')});
	await e.index.search('');
	e.excluded.add('/one/A.xojo_code'); e.index.rediscover();
	assert.deepEqual(names(await e.index.search('')), ['Beta']);
	assert.equal(e.reads.length, 2);
	e.files.clear(); e.files.set('/new/C.xojo_code', routine('NewRoot')); e.index.reset();
	assert.deepEqual(names(await e.index.search('')), ['NewRoot']);
});

test("unsaved documents override disk by URI and closing reverts to the saved version", async () => {
	const e = environment({'/one/A.xojo_code':routine('Saved')});
	await e.index.search('');
	const doc = { uri:uri('/one/A.xojo_code'), languageId:'xojo', version:1, text:routine('Unsaved'), getText(){ return this.text; } };
	e.workspace.textDocuments = [doc];
	assert.deepEqual(names(await e.index.search('')), ['Unsaved']);
	doc.text = routine('Latest'); doc.version++;
	assert.deepEqual(names(await e.index.search('')), ['Latest']);
	e.workspace.textDocuments = [];
	assert.deepEqual(names(await e.index.search('')), ['Saved']);
	e.workspace.textDocuments = [doc]; e.files.set(doc.uri.path, doc.text); e.index.invalidate(doc.uri);
	assert.deepEqual(names(await e.index.search('')), ['Latest']);
	e.workspace.textDocuments = [];
	assert.deepEqual(names(await e.index.search('')), ['Latest']);
	assert.equal(e.reads.length, 2);
});

test("open untitled and library documents participate but Git snapshots do not", async () => {
	const e = environment();
	e.workspace.textDocuments = ['untitled','xojo-library','file','git'].map(scheme => ({
		uri:uri('/Open.xojo_code', scheme), languageId:'xojo', version:1, getText:()=>routine(scheme.replace('-','_')),
	}));
	assert.deepEqual(names(await e.index.search('')), ['untitled','xojo_library','file']);
});

test("renamed or deleted saved models do not resurrect while unsaved text stays searchable", async () => {
	const e = environment({'/one/A.xojo_code':routine('Saved')});
	const doc = {uri:uri('/one/A.xojo_code'),languageId:'xojo',version:1,isDirty:false,getText:()=>routine('Saved')};
	e.workspace.textDocuments = [doc];
	assert.deepEqual(names(await e.index.search('')), ['Saved']);
	e.files.set('/one/Renamed.xojo_code', routine('Saved')); e.files.delete('/one/A.xojo_code'); e.index.remove(doc.uri);
	const renamed = await e.index.search('');
	assert.deepEqual(renamed.map(s=>s.uri.path), ['/one/Renamed.xojo_code']);
	doc.isDirty = true; doc.version++;
	assert.equal((await e.index.search('')).length, 2);
	doc.isDirty = false;
	e.files.clear(); e.index.remove(uri('/one'));
	assert.deepEqual(await e.index.search(''), []);
	e.index.reset();
	assert.deepEqual(await e.index.search(''), []);
});

test("unreadable files are retried and discovery errors keep open documents available", async () => {
	const e = environment({'/one/Bad.xojo_code':new Error('Offline'), '/one/Good.xojo_code':routine('Good')});
	assert.deepEqual(names(await e.index.search('')), ['Good']);
	e.files.set('/one/Bad.xojo_code', routine('Recovered'));
	assert.deepEqual(names(await e.index.search('')), ['Recovered','Good']);
	assert.equal(e.reads.filter(path=>path.endsWith('Good.xojo_code')).length, 1);
	e.workspace.findFiles = async()=>{ throw Error('Offline workspace'); }; e.index.reset();
	e.workspace.textDocuments = [{uri:uri('/Untitled','untitled'),languageId:'xojo',version:1,getText:()=>routine('Open')}];
	assert.deepEqual(names(await e.index.search('')), ['Open']);
});

test("overlapping queries share discovery and file reads", async () => {
	const e = environment({'/one/A.xojo_code':routine('Alpha')});
	const result = await Promise.all([e.index.search('Al'), e.index.search('ap')]);
	assert.deepEqual(result.map(names), [['Alpha'],['Alpha']]);
	assert.equal(e.reads.length, 1);
	assert.equal(e.finds.length, 1);
});

test("cancellation stops scheduling reads after at most four concurrent files", async () => {
	const e = environment(Object.fromEntries(Array.from({length:10},(_,i)=>[`/one/${i}.xojo_code`,routine('A'+i)])));
	const token = {isCancellationRequested:true};
	assert.deepEqual(await e.index.search('', token), []);
	assert.equal(e.finds.length, 0);
	const pending = [];
	e.workspace.fs.readFile = () => new Promise(resolve => pending.push(resolve));
	token.isCancellationRequested = false;
	const request = e.index.search('', token);
	await new Promise(setImmediate);
	assert.equal(pending.length, 4);
	token.isCancellationRequested = true;
	pending.forEach(resolve => resolve(Buffer.from(routine('Read'))));
	assert.deepEqual(await request, []);
	assert.equal(pending.length, 4);
});

test("changed or deleted files cannot publish obsolete in-flight data", async () => {
	const e = environment({'/one/A.xojo_code':routine('Old')});
	let finish;
	e.workspace.fs.readFile = () => new Promise(resolve => { finish = resolve; });
	const request = e.index.search('');
	await new Promise(setImmediate);
	e.index.invalidate(uri('/one/A.xojo_code'));
	finish(Buffer.from(routine('Old')));
	assert.deepEqual(await request, []);
	e.workspace.fs.readFile = async()=>Buffer.from(routine('New'));
	assert.deepEqual(names(await e.index.search('')), ['New']);
	e.index.invalidate(uri('/one/A.xojo_code'));
	e.workspace.fs.readFile = () => new Promise(resolve => { finish = resolve; });
	const deleted = e.index.search('');
	await new Promise(setImmediate);
	e.files.clear(); e.index.remove(uri('/one'));
	finish(Buffer.from(routine('Resurrected')));
	assert.deepEqual(await deleted, []);
	assert.deepEqual(await e.index.search(''), []);
});

test("root changes invalidate in-flight discovery and disposal ignores outstanding reads", async () => {
	const e = environment({'/old/A.xojo_code':routine('Old')});
	let finish;
	e.workspace.findFiles = () => new Promise(resolve => { finish = resolve; });
	const request = e.index.search('');
	await new Promise(setImmediate);
	e.index.reset();
	e.workspace.findFiles = async()=>[uri('/new/B.xojo_code')];
	e.workspace.fs.readFile = async()=>Buffer.from(routine('New'));
	finish([uri('/old/A.xojo_code')]);
	assert.deepEqual(names(await request), ['New']);
	e.index.invalidate(uri('/new/B.xojo_code'));
	e.workspace.fs.readFile = () => new Promise(resolve => { finish = resolve; });
	const disposed = e.index.search('');
	await new Promise(setImmediate);
	e.index.dispose(); finish(Buffer.from(routine('Late')));
	assert.deepEqual(await disposed, []);
	assert.deepEqual(await e.index.search(''), []);
});
