// Run with --extensionTestsPath=<repo>/test/vscode in an isolated VS Code profile.
const vscode = require("vscode");
const assert = require("node:assert/strict");
const path = require("node:path");

async function workspaceSymbols(query) {
	return vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", query);
}

async function eventually(description, check) {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	assert.fail(`Timed out: ${description}`);
}

async function testWorkspaceSymbols() {
	const source = name => `Sub ${name}()\nEnd Sub`;
	const untitled = await vscode.workspace.openTextDocument({ language: "xojo", content: source("WorkspaceUntitledProbe") });
	const symbols = await workspaceSymbols("wup");
	const symbol = symbols.find(s => s.name === "WorkspaceUntitledProbe");
	assert.ok(symbol);
	assert.equal(symbol.location.uri.toString(), untitled.uri.toString());
	assert.equal(symbol.location.range.start.character, 4);
	assert.ok(!(await workspaceSymbols("Methods")).some(s => s.location.uri.toString() === untitled.uri.toString()));

	// Optional disk/watcher tests only write to the explicitly designated disposable workspace.
	const directory = process.env.XOJO_TEST_WORKSPACE;
	if (!directory) return;
	assert.ok(vscode.workspace.workspaceFolders.some(folder => folder.uri.fsPath === directory));
	const scratch = vscode.Uri.file(path.join(directory, "scratch"));
	const original = vscode.Uri.joinPath(scratch, "Symbols.xojo_script");
	const renamed = vscode.Uri.joinPath(scratch, "Renamed.xojo_script");
	await vscode.workspace.fs.createDirectory(scratch);
	await vscode.workspace.fs.writeFile(original, Buffer.from(source("WorkspaceDiskOriginal")));
	await eventually("source creation", async () => (await workspaceSymbols("WorkspaceDiskOriginal")).some(s => s.location.uri.toString() === original.toString()));
	const document = await vscode.workspace.openTextDocument(original);
	await vscode.window.showTextDocument(document);
	const edit = new vscode.WorkspaceEdit();
	edit.replace(original, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source("WorkspaceUnsavedProbe"));
	assert.ok(await vscode.workspace.applyEdit(edit));
	assert.ok((await workspaceSymbols("WorkspaceUnsavedProbe")).some(s => s.location.uri.toString() === original.toString()));
	assert.ok(!(await workspaceSymbols("WorkspaceDiskOriginal")).some(s => s.location.uri.toString() === original.toString()));
	await document.save();
	const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.input?.uri?.toString() === original.toString());
	assert.ok(tab);
	await vscode.window.tabGroups.close(tab);
	await vscode.workspace.fs.rename(original, renamed);
	try {
		await eventually("source rename", async () => {
			const found = await workspaceSymbols("WorkspaceUnsavedProbe");
			return found.some(s => s.location.uri.toString() === renamed.toString()) && !found.some(s => s.location.uri.toString() === original.toString());
		});
	} catch (error) {
		console.log("Rename diagnostics:", JSON.stringify({
			results:(await workspaceSymbols("WorkspaceUnsavedProbe")).map(s=>s.location.uri.toString()),
			documents:vscode.workspace.textDocuments.map(doc=>({uri:doc.uri.toString(),closed:doc.isClosed,dirty:doc.isDirty})),
		}));
		throw error;
	}
	await vscode.workspace.fs.writeFile(renamed, Buffer.from(source("WorkspaceDiskChanged")));
	await eventually("external source change", async () => (await workspaceSymbols("WorkspaceDiskChanged")).some(s => s.location.uri.toString() === renamed.toString()));
	await vscode.workspace.fs.delete(scratch, {recursive:true});
	await eventually("parent folder deletion", async () => !(await workspaceSymbols("WorkspaceDiskChanged")).some(s => s.location.uri.toString() === renamed.toString()));
	console.log("Workspace symbol integration checks passed: creation, unsaved edit, save, rename, disk change and folder deletion.");
}

async function testAgenticRun() {
	const directory = process.env.XOJO_TEST_WORKSPACE;
	if (!directory) return;
	assert.ok(vscode.workspace.workspaceFolders.some(folder => folder.uri.fsPath === directory));
	const scratch = vscode.Uri.file(path.join(directory, "agentic-scratch"));
	const project = vscode.Uri.joinPath(scratch, "AgenticProbe.xojo_project");
	const marker = vscode.Uri.joinPath(scratch, "XojoRunProject.txt");
	const errors = vscode.Uri.joinPath(scratch, "XojoCompileErrors.txt");
	await vscode.workspace.fs.createDirectory(scratch);
	await vscode.workspace.fs.writeFile(project, Buffer.from("Type=Console\nAgenticMode=True\n"));
	// This runs only in an isolated QA profile; do not save unrelated untitled test documents.
	await vscode.workspace.getConfiguration("debug").update("saveBeforeStart", "none", vscode.ConfigurationTarget.Global);
	let pending;
	try {
		pending = vscode.debug.startDebugging(undefined, {
			type: "xojo", request: "launch", name: "Agentic protocol QA",
			projectPath: project.fsPath, runMode: "agentic", openProject: false,
			agenticTimeoutMs: 5000, agenticErrorWaitMs: 50,
		});
		await eventually("Agentic request marker", async () => {
			try { await vscode.workspace.fs.stat(marker); return true; } catch { return false; }
		});
		assert.equal(Buffer.from(await vscode.workspace.fs.readFile(marker)).toString(), "");
		// Simulate the IDE, without launching Xojo or a user application.
		await vscode.workspace.fs.writeFile(errors, Buffer.from("QA simulated compile error"));
		await vscode.workspace.fs.delete(marker);
		assert.equal(await pending, false); // The provider runs the request and intentionally starts no debug adapter.
		assert.equal(Buffer.from(await vscode.workspace.fs.readFile(errors)).toString(), "QA simulated compile error");
		assert.equal(vscode.debug.activeDebugSession, undefined);
		console.log("Agentic F5 integration checks passed: selected manifest, request creation/consumption and raw error observation; Xojo was not launched.");
	} finally {
		await pending;
		await vscode.workspace.fs.delete(scratch, { recursive: true });
	}
}

exports.run = async function () {
	await vscode.extensions.getExtension("nihondo.xojo-syntax").activate();
	const source = 'Var red As Color = &cFF0000\nVar translucent As Color = &c FF 00 00 7F\nVar text As String = "&cFFFFFF"\n\' &cFFFFFF';
	const document = await vscode.workspace.openTextDocument({ language: "xojo", content: source });
	const colors = await vscode.commands.executeCommand("vscode.executeDocumentColorProvider", document.uri);
	assert.equal(colors.length, 2);
	assert.equal(document.getText(colors[0].range), "&cFF0000");
	assert.equal(colors[0].color.alpha, 1);
	assert.ok(Math.abs(colors[1].color.alpha - (1 - 127 / 255)) < 1e-7);
	const presentations = await vscode.commands.executeCommand("vscode.executeColorPresentationProvider",
		new vscode.Color(0, 1, 0, 0.5), { uri: document.uri, range: colors[0].range });
	assert.equal(presentations[0].label, "&c00FF0080");
	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, presentations[0].textEdit.range, presentations[0].textEdit.newText);
	assert.ok(await vscode.workspace.applyEdit(edit));
	assert.ok(document.getText().startsWith("Var red As Color = &c00FF0080\n"));
	const updated = await vscode.commands.executeCommand("vscode.executeDocumentColorProvider", document.uri);
	assert.equal(updated[0].color.green, 1);
	assert.ok(Math.abs(updated[0].color.alpha - (1 - 128 / 255)) < 1e-7);
	console.log("Color provider integration checks passed: extraction, presentation, edit and cache refresh.");
	await testWorkspaceSymbols();
	await testAgenticRun();
};
