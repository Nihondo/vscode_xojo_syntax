const fs = require("node:fs/promises");
const path = require("node:path");
const { runMode, XojoAgenticRunner } = require("./xojoAgentic");

function isInside(directory, file) {
	const relative = path.relative(directory, file);
	return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

/** Shared command/F5 routing; existing IDE shortcut automation is injected unchanged. */
class XojoRunController {
	constructor(vscode, { legacyRun, openProject, platform = process.platform, runner = new XojoAgenticRunner() }) {
		this.vscode = vscode;
		this.legacyRun = legacyRun;
		this.openProject = openProject;
		this.platform = platform;
		this.runner = runner;
		this.output = null;
	}

	async selectProject(options) {
		const { workspace, window, Uri, RelativePattern } = this.vscode;
		if (options.projectPath) {
			const base = options.folderUri || workspace.workspaceFolders?.[0]?.uri;
			const file = path.isAbsolute(options.projectPath) ? options.projectPath :
				base?.scheme === "file" ? path.resolve(base.fsPath, options.projectPath) : null;
			if (!file || !/\.xojo_project$/i.test(file) || !(await fs.stat(file)).isFile()) {
				throw new Error("projectPathにはローカルの.xojo_projectファイルを指定してください。");
			}
			return Uri.file(file);
		}
		const folders = options.folderUri ? [options.folderUri] : (workspace.workspaceFolders || []).map(folder => folder.uri);
		const found = await Promise.all(folders.filter(uri => uri.scheme === "file")
			.map(uri => workspace.findFiles(new RelativePattern(uri, "**/*.xojo_project"))));
		const candidates = [...new Map(found.flat().map(uri => [uri.toString(), uri])).values()]
			.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
		const active = window.activeTextEditor?.document.uri;
		if (active?.scheme === "file") {
			const exact = candidates.find(uri => uri.fsPath === active.fsPath);
			if (exact) return exact;
			const enclosing = candidates.filter(uri => isInside(path.dirname(uri.fsPath), active.fsPath));
			if (enclosing.length) {
				const nearest = Math.max(...enclosing.map(uri => path.dirname(uri.fsPath).length));
				const preferred = enclosing.filter(uri => path.dirname(uri.fsPath).length === nearest);
				if (preferred.length === 1) return preferred[0];
				return this.pickProject(preferred);
			}
		}
		if (candidates.length <= 1) return candidates[0];
		return this.pickProject(candidates);
	}

	async pickProject(projects) {
		const selected = await this.vscode.window.showQuickPick(projects.map(uri => ({
			label: path.basename(uri.fsPath), description: path.dirname(uri.fsPath), uri,
		})), { placeHolder: "実行するXojoプロジェクトを選択", matchOnDescription: true });
		return selected?.uri || null; // null means selection was cancelled, undefined means none found.
	}

	async run(options = {}) {
		try {
			const project = await this.selectProject(options);
			if (project === null) return;
			const mode = options.runMode ?? this.vscode.workspace.getConfiguration("xojo", project || options.folderUri).get("run.mode", "auto");
			const manifest = mode === "auto" && project ? await fs.readFile(project.fsPath, "utf8") : "";
			if (runMode(mode, manifest) === "legacy") {
				return await this.legacyRun({ ...options, projectUri: project });
			}
			if (!project) throw new Error("Agentic実行の対象となる.xojo_projectファイルが見つかりません。");
			return await this.runAgentic(project, options);
		} catch (error) {
			this.vscode.window.showErrorMessage("Xojo 実行に失敗しました: " + error.message);
		}
	}

	async runAgentic(project, options) {
		const { window, ProgressLocation } = this.vscode;
		if (!this.output) this.output = window.createOutputChannel("Xojo");
		const output = this.output;
		// Only macOS has an existing application-opening implementation.
		// On other platforms the selected project must already be open in Agentic Mode.
		if (this.platform === "darwin" && options.openProject !== false) {
			await this.openProject(project);
			const delay = Number.isFinite(options.openDelayMs) ? Math.max(0, options.openDelayMs) : 800;
			if (delay) await new Promise(resolve => setTimeout(resolve, delay));
		}
		output.appendLine("\nXojo Agentic: " + project.fsPath);
		const result = await window.withProgress({
			location: ProgressLocation.Notification, title: "Xojo: " + path.basename(project.fsPath), cancellable: true,
		}, (progress, token) => this.runner.run(project.fsPath, {
			timeoutMs: options.agenticTimeoutMs, errorWaitMs: options.agenticErrorWaitMs, token,
			onStatus: status => progress.report({ message: status === "pending" ?
				"Xojoの受付を待っています。対象プロジェクトをAgentic Modeで開いてください。" :
				"実行要求の受付を確認しました。コンパイルエラーを確認しています。" }),
		}));
		if (result.status === "timeout") {
			output.appendLine("受付を確認できませんでした。待機中の自分の要求を削除しました。");
			window.showWarningMessage("Xojoが実行要求を受け付けませんでした。対象プロジェクトとAgentic Modeを確認してください。");
		} else if (result.status === "cancelled") {
			output.appendLine(result.consumed ? "監視をキャンセルしました。Xojoの実行は停止しません。" : "実行要求の待機をキャンセルしました。");
		} else if (result.errors?.trim()) {
			output.appendLine(result.errorsFile + "\n" + result.errors);
			output.show(true);
			window.showWarningMessage("Xojoからコンパイルエラー出力を受信しました。「出力」のXojoを確認してください。");
		} else {
			const message = result.staleErrors ? "既存のエラーファイルは更新されていません。今回の結果とは判定していません。" :
				"確認時間内に新しいコンパイルエラー出力はありません。コンパイル成功やアプリの動作完了を保証するものではありません。";
			output.appendLine(message);
			window.showInformationMessage("Xojo実行要求の受付を確認しました。" + message);
		}
		return result;
	}

	dispose() {
		this.runner.dispose();
		this.output?.dispose();
	}
}

module.exports = { XojoRunController };
