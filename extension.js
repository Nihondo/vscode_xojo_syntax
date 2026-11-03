// Xojo DocumentSymbolProvider
// - Generic symbols for Sub/Function/Method/Event/Delegate in code files
// - Hierarchical symbols for .xojo_window (Window -> Controls -> Events/Methods/Properties/MenuHandlers)

const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { scanXojoSource, getXojoDocumentKind, buildXojoOutline, collectFoldingRanges, collectColorLiterals, formatColorLiteral } = require("./src/xojoSyntax");
const { XojoWorkspaceIndex } = require("./src/xojoWorkspaceSymbols");
const { XojoRunController } = require("./src/xojoRun");
const analysisCache = new WeakMap();

const XOJO_LIBRARY_SCHEME = "xojo-library";
const XOJO_SOURCE_EXTENSIONS = [
	".xojo_code",
	".xojo_script",
	".xojo_window",
	".xojo_menu",
];

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	const selector = [
		{ language: "xojo", scheme: "file" },
		{ language: "xojo", scheme: "untitled" },
		{ language: "xojo", scheme: XOJO_LIBRARY_SCHEME },
	];

	const xojoLibraryContentProvider = new XojoLibraryContentProvider();
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(
			XOJO_LIBRARY_SCHEME,
			xojoLibraryContentProvider
		)
	);

	// Utility: sleep
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	// Find first *.xojo_project in a folder
	async function findXojoProjectInFolder(folderUri) {
		try {
			if (!folderUri) return null;
			const pattern = new vscode.RelativePattern(
				folderUri,
				"*.xojo_project"
			);
			const found = await vscode.workspace.findFiles(
				pattern,
				undefined,
				1
			);
			return found && found.length ? found[0] : null;
		} catch {
			return null;
		}
	}

	// Open Xojo app with optional project path
	async function openXojoApp(projectUri) {
		await new Promise((resolve, reject) => {
			const args = projectUri
				? ["-a", "Xojo", projectUri.fsPath]
				: ["-a", "Xojo"];
			const child = cp.spawn("/usr/bin/open", args, { stdio: "ignore" });
			child.on("error", reject);
			child.on("exit", (code) =>
				code === 0
					? resolve()
					: reject(new Error(`open exited with code ${code}`))
			);
		});
	}

	// Command: Xojo Reload and Run with configurable waits
	// options: { folderUri?: Uri, openProject?: boolean (default true), openDelayMs?: number (default 800), reloadToRunDelayMs?: number (default 500) }
	async function xojoLegacyReloadAndRun(options = {}) {
		if (process.platform !== "darwin") {
			vscode.window.showWarningMessage(
				"Xojo: この機能は macOS でのみ利用できます。"
			);
			return;
		}

		const folderUri =
			options.folderUri ||
			vscode.workspace.workspaceFolders?.[0]?.uri ||
			null;
		const openProject = options.openProject !== false; // default true
		const openDelayMs = Number.isFinite(options.openDelayMs)
			? Math.max(0, options.openDelayMs)
			: 800;
		const reloadDialogDelayMs = Number.isFinite(options.reloadDialogDelayMs)
			? Math.max(0, options.reloadDialogDelayMs)
			: 300;
		const reloadToRunDelayMs = Number.isFinite(options.reloadToRunDelayMs)
			? Math.max(0, options.reloadToRunDelayMs)
			: 500;

		if (openProject) {
			let proj = options.projectUri || await findXojoProjectInFolder(folderUri);
			if (!proj) {
				vscode.window.showWarningMessage(
					"*.xojo_project が見つかりませんでした。Xojo を空で起動します。"
				);
			}
			try {
				await openXojoApp(proj);
			} catch (err) {
				vscode.window.showErrorMessage(
					`Xojo 起動に失敗しました: ${err.message}`
				);
				return;
			}
			if (openDelayMs > 0) await sleep(openDelayMs);
		} else {
			// 少なくともアクティベート
			await new Promise((resolve, reject) => {
				const child = cp.spawn(
					"/usr/bin/osascript",
					["-e", 'tell application "Xojo" to activate'],
					{ stdio: "ignore" }
				);
				child.on("error", reject);
				child.on("exit", () => resolve());
			}).catch(() => {});
		}

		const osaArgs = [
			"-e",
			'tell application "Xojo" to activate',
			"-e",
			'tell application "System Events" to keystroke "r" using {command down, shift down}',
			"-e",
			`delay ${reloadDialogDelayMs / 1000}`,
			"-e",
			'tell application "System Events" to key code 36',
			"-e",
			`delay ${reloadToRunDelayMs / 1000}`,
			"-e",
			'tell application "System Events" to keystroke "r" using {command down}',
		];
		await sleep(50);
		await new Promise((resolve, reject) => {
			const child = cp.spawn("/usr/bin/osascript", osaArgs, {
				stdio: "ignore",
			});
			child.on("error", reject);
			child.on("exit", (code) => {
				if (code === 0) resolve();
				else reject(new Error(`osascript exited with code ${code}`));
			});
		}).catch((err) => {
			vscode.window.showErrorMessage(
				`Xojo 実行に失敗しました: ${err.message}`
			);
		});
	}

	const runController = new XojoRunController(vscode, {
		legacyRun: xojoLegacyReloadAndRun,
		openProject: openXojoApp,
	});
	context.subscriptions.push(runController);

	context.subscriptions.push(
		vscode.commands.registerCommand("xojo.reloadAndRun", async () => {
			await runController.run();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"xojo.openLibraryApiFile",
			async (resourceUri) => {
				await openXojoLibraryApiFile(resourceUri);
			}
		)
	);

	// Debug provider: type 'xojo' to run reload+run on F5
	const debugProvider = {
		provideDebugConfigurations(folder) {
			return [
				{
					type: "xojo",
					request: "launch",
					name: "Xojo: Reload and Run",
					openProject: true,
					openDelayMs: 800,
					reloadDialogDelayMs: 300,
					reloadToRunDelayMs: 500,
					agenticTimeoutMs: 30000,
					agenticErrorWaitMs: 10000,
				},
			];
		},
		async resolveDebugConfiguration(folder, config) {
			// launch.json が無い、または空のときはデフォルトを補完
			if (!config || !config.type || !config.request) {
				config = {
					type: "xojo",
					request: "launch",
					name: "Xojo: Reload and Run",
				};
			}
			await runController.run({
				folderUri: folder?.uri,
				runMode: config.runMode,
				projectPath: config.projectPath,
				agenticTimeoutMs: config.agenticTimeoutMs,
				agenticErrorWaitMs: config.agenticErrorWaitMs,
				openProject: config.openProject !== false,
				openDelayMs: Number.isFinite(config.openDelayMs)
					? config.openDelayMs
					: 800,
				reloadDialogDelayMs: Number.isFinite(config.reloadDialogDelayMs)
					? config.reloadDialogDelayMs
					: 300,
				reloadToRunDelayMs: Number.isFinite(config.reloadToRunDelayMs)
					? config.reloadToRunDelayMs
					: 500,
			});
			return null;
		},
	};
	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider("xojo", debugProvider)
	);

	// Optional: 明示的に .vscode/launch.json を作成するコマンド
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"xojo.createDefaultLaunch",
			async () => {
				const ws = vscode.workspace.workspaceFolders?.[0];
				if (!ws) {
					vscode.window.showWarningMessage(
						"ワークスペースフォルダがありません。"
					);
					return;
				}
				const vscodeDir = vscode.Uri.joinPath(ws.uri, ".vscode");
				const launchUri = vscode.Uri.joinPath(vscodeDir, "launch.json");
				try {
					await vscode.workspace.fs.stat(launchUri);
					vscode.window.showInformationMessage(
						".vscode/launch.json は既に存在します。"
					);
					return;
				} catch (_) {
					// not exists
				}
				await vscode.workspace.fs.createDirectory(vscodeDir);
				const content = JSON.stringify(
					{
						version: "0.2.0",
						configurations: [
							{
								type: "xojo",
								request: "launch",
								name: "Xojo: Reload and Run",
								openProject: true,
								openDelayMs: 800,
								reloadDialogDelayMs: 300,
								reloadToRunDelayMs: 500,
								agenticTimeoutMs: 30000,
								agenticErrorWaitMs: 10000,
							},
						],
					},
					null,
					2
				);
				await vscode.workspace.fs.writeFile(
					launchUri,
					Buffer.from(content, "utf8")
				);
				vscode.window.showInformationMessage(
					".vscode/launch.json を作成しました。"
				);
			}
		)
	);

	const provider = new (class {
		/**
		 * @param {vscode.TextDocument} document
		 * @returns {vscode.ProviderResult<vscode.DocumentSymbol[]>}
		 */
		provideDocumentSymbols(document) {
			const analysis = getXojoAnalysis(document);
			const kind = getXojoDocumentKind(analysis, document.uri.path || document.fileName);
			if (kind === "menu") {
				return parseXojoMenuSymbols(document);
			}
			if (kind === "window") {
				return parseXojoWindowSymbols(document);
			}
			if (kind === "object") {
				return parseXojoObjectSymbols(document);
			}
			return parseGenericFunctionSymbols(document);
		}
	})();

	context.subscriptions.push(
		vscode.languages.registerDocumentSymbolProvider(selector, provider)
	);
	context.subscriptions.push(
		vscode.languages.registerFoldingRangeProvider(selector, {
			provideFoldingRanges(document) {
				return collectFoldingRanges(getXojoAnalysis(document))
					.map(range => new vscode.FoldingRange(range.start, range.end));
			},
		})
	);
	context.subscriptions.push(
		vscode.languages.registerColorProvider(selector, {
			provideDocumentColors(document) {
				return collectColorLiterals(getXojoAnalysis(document)).map(color =>
					new vscode.ColorInformation(
						new vscode.Range(document.positionAt(color.start), document.positionAt(color.end)),
						new vscode.Color(color.red, color.green, color.blue, color.alpha)
					)
				);
			},
			provideColorPresentations(color, { document, range }) {
				if (document.uri.scheme === XOJO_LIBRARY_SCHEME) return [];
				const label = formatColorLiteral(color, document.getText(range));
				if (!label) return [];
				const presentation = new vscode.ColorPresentation(label);
				presentation.textEdit = vscode.TextEdit.replace(range, label);
				return [presentation];
			},
		})
	);
	registerXojoWorkspaceSymbols(context);

}

function deactivate() {}

module.exports = { activate, deactivate };

// ------------------ Helpers ------------------

/**
 * Xojoライブラリ内のAPIファイルを読み取り専用ドキュメントとして提供する。
 */
class XojoLibraryContentProvider {
	/**
	 * Xojoライブラリ内の指定エントリの内容を返す。
	 * @param {vscode.Uri} uri
	 * @returns {string}
	 */
	provideTextDocumentContent(uri) {
		const { libraryPath, entryName } = decodeXojoLibraryUri(uri);
		return readXojoLibraryEntryText(libraryPath, entryName);
	}
}

/**
 * `.xojo_library`内のAPIファイルを選択し、Xojo仮想ドキュメントとして開く。
 * @param {vscode.Uri | undefined} resourceUri
 */
async function openXojoLibraryApiFile(resourceUri) {
	const libraryUri = await resolveXojoLibraryUri(resourceUri);
	if (!libraryUri) return;

	let entries;
	try {
		entries = listXojoLibraryApiEntries(libraryUri.fsPath);
	} catch (err) {
		vscode.window.showErrorMessage(
			`Xojo library の読み込みに失敗しました: ${err.message}`
		);
		return;
	}

	if (!entries.length) {
		vscode.window.showInformationMessage(
			"Xojo library の API 配下に表示可能な Xojo ファイルが見つかりませんでした。"
		);
		return;
	}

	let selectedEntry = entries[0];
	if (entries.length > 1) {
		const picked = await vscode.window.showQuickPick(
			entries.map((entryName) => ({
				label: path.basename(entryName),
				description: path.dirname(entryName),
				entryName,
			})),
			{ placeHolder: "API 配下の Xojo ファイルを選択" }
		);
		if (!picked) return;
		selectedEntry = picked.entryName;
	}

	const documentUri = createXojoLibraryUri(libraryUri.fsPath, selectedEntry);
	const document = await vscode.workspace.openTextDocument(documentUri);
	const xojoDocument = await vscode.languages.setTextDocumentLanguage(
		document,
		"xojo"
	);
	await vscode.window.showTextDocument(xojoDocument, { preview: false });
}

/**
 * コマンド引数、アクティブエディタ、ファイル選択から`.xojo_library`のURIを解決する。
 * @param {vscode.Uri | undefined} resourceUri
 * @returns {Promise<vscode.Uri | null>}
 */
async function resolveXojoLibraryUri(resourceUri) {
	if (isXojoLibraryUri(resourceUri)) return resourceUri;

	const activeUri = vscode.window.activeTextEditor?.document?.uri;
	if (isXojoLibraryUri(activeUri)) return activeUri;

	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		filters: { "Xojo Library": ["xojo_library"] },
		openLabel: "Open Library",
	});
	return picked?.[0] || null;
}

/**
 * URIが`.xojo_library`ファイルを指しているか判定する。
 * @param {vscode.Uri | undefined} uri
 * @returns {boolean}
 */
function isXojoLibraryUri(uri) {
	return Boolean(uri?.scheme === "file" && /\.xojo_library$/i.test(uri.fsPath));
}

/**
 * Xojoライブラリ内API配下の表示可能なXojoファイルを列挙する。
 * @param {string} libraryPath
 * @returns {string[]}
 */
function listXojoLibraryApiEntries(libraryPath) {
	return readZipEntries(libraryPath)
		.filter((entry) => {
			if (entry.isDirectory) return false;
			if (!/(^|\/)API\//i.test(entry.name)) return false;
			return XOJO_SOURCE_EXTENSIONS.some((ext) =>
				entry.name.toLowerCase().endsWith(ext)
			);
		})
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b));
}

/**
 * Xojoライブラリ内の指定APIファイルをUTF-8テキストとして読み込む。
 * @param {string} libraryPath
 * @param {string} entryName
 * @returns {string}
 */
function readXojoLibraryEntryText(libraryPath, entryName) {
	const buffer = readZipEntryBuffer(libraryPath, entryName);
	return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

/**
 * Xojoライブラリ内エントリを表す仮想ドキュメントURIを作成する。
 * @param {string} libraryPath
 * @param {string} entryName
 * @returns {vscode.Uri}
 */
function createXojoLibraryUri(libraryPath, entryName) {
	const payload = encodeBase64Url(JSON.stringify({ libraryPath, entryName }));
	const entryBasename = path.basename(entryName);
	return vscode.Uri.from({
		scheme: XOJO_LIBRARY_SCHEME,
		path: `/${entryBasename}`,
		query: payload,
	});
}

/**
 * Xojoライブラリ仮想URIから元ファイルパスとzip内エントリ名を復元する。
 * @param {vscode.Uri} uri
 * @returns {{libraryPath: string, entryName: string}}
 */
function decodeXojoLibraryUri(uri) {
	try {
		const raw = decodeBase64Url(uri.query || "");
		const payload = JSON.parse(raw);
		if (
			typeof payload.libraryPath === "string" &&
			typeof payload.entryName === "string"
		) {
			return payload;
		}
	} catch (_) {
		// fall through
	}
	throw new Error("Invalid Xojo library URI");
}

/**
 * zipの中央ディレクトリからエントリ一覧を読み取る。
 * @param {string} zipPath
 * @returns {Array<{name: string, compressionMethod: number, compressedSize: number, localHeaderOffset: number, isDirectory: boolean}>}
 */
function readZipEntries(zipPath) {
	const archive = fs.readFileSync(zipPath);
	const eocdOffset = findEndOfCentralDirectoryOffset(archive);
	if (eocdOffset < 0) {
		throw new Error("zip の中央ディレクトリが見つかりません。");
	}

	const entryCount = archive.readUInt16LE(eocdOffset + 10);
	const centralDirectoryOffset = archive.readUInt32LE(eocdOffset + 16);
	const entries = [];
	let offset = centralDirectoryOffset;

	for (let i = 0; i < entryCount; i++) {
		if (archive.readUInt32LE(offset) !== 0x02014b50) {
			throw new Error("zip の中央ディレクトリ形式が不正です。");
		}
		const generalPurposeFlag = archive.readUInt16LE(offset + 8);
		const compressionMethod = archive.readUInt16LE(offset + 10);
		const compressedSize = archive.readUInt32LE(offset + 20);
		const fileNameLength = archive.readUInt16LE(offset + 28);
		const extraLength = archive.readUInt16LE(offset + 30);
		const commentLength = archive.readUInt16LE(offset + 32);
		const localHeaderOffset = archive.readUInt32LE(offset + 42);
		const nameStart = offset + 46;
		const nameEnd = nameStart + fileNameLength;
		const encoding = generalPurposeFlag & 0x0800 ? "utf8" : "utf8";
		const name = archive.toString(encoding, nameStart, nameEnd);

		entries.push({
			name,
			compressionMethod,
			compressedSize,
			localHeaderOffset,
			isDirectory: name.endsWith("/"),
		});

		offset = nameEnd + extraLength + commentLength;
	}

	return entries;
}

/**
 * zip内の指定エントリをBufferとして展開する。
 * @param {string} zipPath
 * @param {string} entryName
 * @returns {Buffer}
 */
function readZipEntryBuffer(zipPath, entryName) {
	const archive = fs.readFileSync(zipPath);
	const entry = readZipEntries(zipPath).find((item) => item.name === entryName);
	if (!entry) {
		throw new Error(`zip エントリが見つかりません: ${entryName}`);
	}
	if (archive.readUInt32LE(entry.localHeaderOffset) !== 0x04034b50) {
		throw new Error("zip のローカルヘッダ形式が不正です。");
	}

	const fileNameLength = archive.readUInt16LE(entry.localHeaderOffset + 26);
	const extraLength = archive.readUInt16LE(entry.localHeaderOffset + 28);
	const dataStart = entry.localHeaderOffset + 30 + fileNameLength + extraLength;
	const compressed = archive.subarray(
		dataStart,
		dataStart + entry.compressedSize
	);

	if (entry.compressionMethod === 0) return Buffer.from(compressed);
	if (entry.compressionMethod === 8) return zlib.inflateRawSync(compressed);

	throw new Error(
		`未対応のzip圧縮方式です: ${entry.compressionMethod} (${entryName})`
	);
}

/**
 * zipのEnd of Central Directoryレコード位置を後方検索で見つける。
 * @param {Buffer} archive
 * @returns {number}
 */
function findEndOfCentralDirectoryOffset(archive) {
	if (archive.length < 22) return -1;
	const minOffset = Math.max(0, archive.length - 0xffff - 22);
	for (let offset = archive.length - 22; offset >= minOffset; offset--) {
		if (archive.readUInt32LE(offset) === 0x06054b50) {
			return offset;
		}
	}
	return -1;
}

/**
 * JSONペイロード用にBase64 URLエンコードする。
 * @param {string} value
 * @returns {string}
 */
function encodeBase64Url(value) {
	return Buffer.from(value, "utf8")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

/**
 * Base64 URLエンコードされたJSONペイロードをデコードする。
 * @param {string} value
 * @returns {string}
 */
function decodeBase64Url(value) {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
	return Buffer.from(normalized + padding, "base64").toString("utf8");
}

/** Reuse the same source analysis for symbols and physical folding ranges. */
function getXojoAnalysis(document) {
	const cached = analysisCache.get(document);
	if (cached && cached.version === document.version) return cached.analysis;
	const analysis = scanXojoSource(document.getText());
	analysisCache.set(document, { version: document.version, analysis });
	return analysis;
}

function registerXojoWorkspaceSymbols(context) {
	const index = new XojoWorkspaceIndex(vscode.workspace, getXojoAnalysis);
	// Folder operations may emit only a folder event, not individual source-file events.
	const watcher = vscode.workspace.createFileSystemWatcher("**/*");
	context.subscriptions.push(
		index, watcher,
		watcher.onDidCreate(() => index.rediscover()),
		watcher.onDidChange(uri => index.invalidate(uri)),
		watcher.onDidDelete(uri => index.remove(uri)),
		vscode.workspace.onDidSaveTextDocument(document => index.invalidate(document.uri)),
		vscode.workspace.onDidChangeWorkspaceFolders(() => index.reset()),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration("files.exclude")) index.rediscover();
		}),
		vscode.languages.registerWorkspaceSymbolProvider({
			async provideWorkspaceSymbols(query, token) {
				const symbols = await index.search(query, token);
				return symbols.map(symbol => new vscode.SymbolInformation(
					symbol.name, vscode.SymbolKind[symbol.kind], symbol.containerName,
					new vscode.Location(symbol.uri, new vscode.Range(
						new vscode.Position(symbol.range.start.line, symbol.range.start.character),
						new vscode.Position(symbol.range.end.line, symbol.range.end.character)
					))
				));
			},
		})
	);
}

function toDocumentSymbols(document, models) {
	return models.map(model => {
		const symbol = new vscode.DocumentSymbol(
			model.name, model.detail, vscode.SymbolKind[model.kind],
			new vscode.Range(document.positionAt(model.start), document.positionAt(model.end)),
			new vscode.Range(document.positionAt(model.selectionStart), document.positionAt(model.selectionEnd))
		);
		symbol.children = toDocumentSymbols(document, model.children);
		return symbol;
	});
}

function parseGenericFunctionSymbols(document) {
	return toDocumentSymbols(document, buildXojoOutline(getXojoAnalysis(document), "generic"));
}

function parseXojoObjectSymbols(document) {
	return toDocumentSymbols(document, buildXojoOutline(getXojoAnalysis(document), "object"));
}

function parseXojoWindowSymbols(document) {
	return toDocumentSymbols(document, buildXojoOutline(getXojoAnalysis(document), "window"));
}

function parseXojoMenuSymbols(document) {
	return toDocumentSymbols(document, buildXojoOutline(getXojoAnalysis(document), "menu"));
}
