const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { XojoRunController } = require("../src/xojoRun");

function uri(file) { return { scheme: "file", fsPath: file, toString: () => "file://" + file }; }

async function setup(t, config = {}) {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "xojo-run-")));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const project = uri(path.join(directory, "App.xojo_project"));
	await fs.writeFile(project.fsPath, "AgenticMode=True\n");
	const calls = { legacy: [], opened: [], runs: [], errors: [], warnings: [], infos: [], output: [], picks: [] };
	const runner = { dispose() {}, async run(file, options) {
		calls.runs.push({ file, options });
		options.onStatus("pending"); options.onStatus("consumed");
		return config.result || { status: "observed", consumed: true, errors: null };
	} };
	const vscode = {
		Uri: { file: uri },
		RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
		ProgressLocation: { Notification: 15 },
		workspace: {
			workspaceFolders: [{ uri: uri(directory) }],
			findFiles: async () => [project],
			getConfiguration: () => ({ get: () => config.mode || "auto" }),
		},
		window: {
			showQuickPick: async items => { calls.picks.push(items); return config.cancelPick ? undefined : items[1]; },
			showErrorMessage: message => calls.errors.push(message),
			showWarningMessage: message => calls.warnings.push(message),
			showInformationMessage: message => calls.infos.push(message),
			createOutputChannel: () => ({ appendLine: line => calls.output.push(line), show: () => calls.shown = true, dispose() {} }),
			withProgress: async (options, task) => {
				calls.progress = options;
				return task({ report: update => calls.output.push(update.message) }, { isCancellationRequested: false });
			},
		},
	};
	const controller = new XojoRunController(vscode, {
		runner, platform: config.platform || "linux",
		legacyRun: async options => calls.legacy.push(options),
		openProject: async selected => calls.opened.push(selected),
	});
	t.after(() => controller.dispose());
	return { directory, project, calls, runner, vscode, controller };
}

test("auto routes enabled projects through the marker runner on non-macOS without shortcuts", async t => {
	const f = await setup(t);
	await f.controller.run({ agenticTimeoutMs: 123, agenticErrorWaitMs: 456 });
	assert.equal(f.calls.legacy.length, 0);
	assert.equal(f.calls.opened.length, 0);
	assert.equal(f.calls.runs[0].file, f.project.fsPath);
	assert.equal(f.calls.runs[0].options.timeoutMs, 123);
	assert.equal(f.calls.runs[0].options.errorWaitMs, 456);
	assert.equal(f.calls.progress.cancellable, true);
	assert.match(f.calls.infos[0], /保証するものではありません/);
});

test("legacy routing and launch overrides retain the selected project and old delay options", async t => {
	const f = await setup(t);
	await fs.writeFile(f.project.fsPath, "AgenticMode=False");
	await f.controller.run({ reloadDialogDelayMs: 234, reloadToRunDelayMs: 567, openProject: false });
	assert.equal(f.calls.legacy[0].projectUri.fsPath, f.project.fsPath);
	assert.equal(f.calls.legacy[0].reloadDialogDelayMs, 234);
	assert.equal(f.calls.legacy[0].reloadToRunDelayMs, 567);
	assert.equal(f.calls.legacy[0].openProject, false);
	await f.controller.run({ runMode: "agentic" });
	assert.equal(f.calls.runs.length, 1);
	await fs.writeFile(f.project.fsPath, "AgenticMode=True");
	await f.controller.run({ runMode: "legacy" });
	assert.equal(f.calls.legacy.length, 2);
});

test("workspace mode is used unless explicitly overridden by the launch configuration", async t => {
	const f = await setup(t, { mode: "legacy" });
	await f.controller.run();
	assert.equal(f.calls.legacy.length, 1);
	await f.controller.run({ runMode: "agentic" });
	assert.equal(f.calls.runs.length, 1);
});

test("macOS opens the selected project only when openProject is enabled", async t => {
	const f = await setup(t, { platform: "darwin" });
	await f.controller.run({ openDelayMs: 0 });
	assert.deepEqual(f.calls.opened, [f.project]);
	await f.controller.run({ openProject: false });
	assert.equal(f.calls.opened.length, 1);
});

test("explicit relative projectPath wins over discovery and is checked before creating a marker", async t => {
	const f = await setup(t);
	const explicit = path.join(f.directory, "Nested", "Other.xojo_project");
	await fs.mkdir(path.dirname(explicit)); await fs.writeFile(explicit, "AgenticMode=True");
	await f.controller.run({ folderUri: uri(f.directory), projectPath: "Nested/Other.xojo_project" });
	assert.equal(f.calls.runs[0].file, explicit);
	await f.controller.run({ projectPath: path.join(f.directory, "missing.xojo_project") });
	assert.equal(f.calls.errors.length, 1);
	assert.equal(f.calls.runs.length, 1);
});

test("active manifest or nearest enclosing project is preferred across roots; ambiguity asks once", async t => {
	const f = await setup(t);
	const nested = uri(path.join(f.directory, "Nested", "Other.xojo_project"));
	f.vscode.workspace.findFiles = async () => [f.project, nested];
	f.vscode.window.activeTextEditor = { document: { uri: uri(path.join(f.directory, "Nested", "Module.xojo_code")) } };
	assert.equal(await f.controller.selectProject({}), nested);
	f.vscode.window.activeTextEditor.document.uri = f.project;
	assert.equal(await f.controller.selectProject({}), f.project);
	f.vscode.window.activeTextEditor = undefined;
	assert.equal(await f.controller.selectProject({}), nested);
	assert.equal(f.calls.picks.length, 1);
	// The F5 folder limits discovery rather than silently searching another workspace root.
	let requested;
	f.vscode.workspace.findFiles = async pattern => { requested = pattern; return [f.project]; };
	await f.controller.selectProject({ folderUri: uri(f.directory) });
	assert.equal(requested.base.fsPath, f.directory);
	assert.equal(requested.pattern, "**/*.xojo_project");
});

test("cancelled project selection performs no run; missing projects never create markers in agentic mode", async t => {
	const f = await setup(t, { cancelPick: true });
	f.vscode.workspace.findFiles = async () => [f.project, uri(path.join(f.directory, "Other.xojo_project"))];
	await f.controller.run();
	assert.equal(f.calls.runs.length, 0);
	assert.equal(f.calls.legacy.length, 0);
	f.vscode.workspace.findFiles = async () => [];
	await f.controller.run({ runMode: "agentic" });
	assert.equal(f.calls.runs.length, 0);
	assert.match(f.calls.errors[0], /見つかりません/);
});

test("fresh errors are shown raw; timeout never falls back to a second legacy run", async t => {
	const f = await setup(t, { result: { status: "observed", errors: "Module1.Run: type error", errorsFile: "XojoCompileErrors.txt" } });
	await f.controller.run();
	assert.equal(f.calls.shown, true);
	assert.ok(f.calls.output.some(line => /Module1.Run: type error/.test(line)));
	f.runner.run = async () => ({ status: "timeout" });
	await f.controller.run();
	assert.match(f.calls.warnings.at(-1), /受け付けません/);
	assert.equal(f.calls.legacy.length, 0);
});

test("run exceptions are surfaced and opening failure does not submit a request", async t => {
	const f = await setup(t, { platform: "darwin" });
	f.controller.openProject = async () => { throw new Error("open failed"); };
	await f.controller.run();
	assert.match(f.calls.errors[0], /open failed/);
	assert.equal(f.calls.runs.length, 0);
});
