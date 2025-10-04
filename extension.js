// Xojo DocumentSymbolProvider
// - Generic symbols for Sub/Function/Method/Event/Delegate in code files
// - Hierarchical symbols for .xojo_window (Window -> Controls -> Events/Methods/Properties/MenuHandlers)

const vscode = require("vscode");
const cp = require("child_process");

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	const selector = [
		{ language: "xojo", scheme: "file" },
		{ language: "xojo", scheme: "untitled" },
	];

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
	async function xojoReloadAndRun(options = {}) {
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
			let proj = await findXojoProjectInFolder(folderUri);
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

	context.subscriptions.push(
		vscode.commands.registerCommand("xojo.reloadAndRun", async () => {
			const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
			await xojoReloadAndRun({ folderUri });
		})
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
			await xojoReloadAndRun({
				folderUri:
					folder?.uri || vscode.workspace.workspaceFolders?.[0]?.uri,
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
			const text = document.getText();
			const isXojoMenu =
				/\.xojo_menu$/i.test(document.fileName || "") ||
				/^#tag\s+Menu\b/im.test(text) ||
				/^Begin\s+Menu\s+/im.test(text);
			const isXojoWindow =
				/\.xojo_window$/i.test(document.fileName || "") ||
				/^Begin\s+(?:DesktopWindow|Window)\b/im.test(text) ||
				/^#tag\s+Window\b/im.test(text);
			const isXojoCodeObject =
				/\.xojo_code$/i.test(document.fileName || "") &&
				(/^\s*#tag\s+(?:Class|Module|Interface|Structure|Enum)\b/im.test(text) ||
					/^\s*(?:Private|Public|Protected)?\s*(?:Class|Module|Interface|Structure|Enum)\s+[A-Za-z_][A-Za-z0-9_]*/im.test(
						text
					));
			if (isXojoMenu) {
				return parseXojoMenuSymbols(document, text);
			}
			if (isXojoWindow) {
				return parseXojoWindowSymbols(document, text);
			}
			if (isXojoCodeObject) {
				return parseXojoObjectSymbols(document, text);
			}
			return parseGenericFunctionSymbols(document, text);
		}
	})();

	context.subscriptions.push(
		vscode.languages.registerDocumentSymbolProvider(selector, provider)
	);
}

function deactivate() {}

module.exports = { activate, deactivate };

// ------------------ Helpers ------------------

/**
 * Parse #tag blocks (Method, Property, Event, Constant) common to both .xojo_code and .xojo_window
 * @param {string[]} lines
 * @param {number} startLine
 * @param {number} endLine
 * @param {Function} rangeLines
 * @param {Function} ensureGroup
 * @param {Record<string, vscode.DocumentSymbol> | Array<{name: string, path: string[], symbol: vscode.DocumentSymbol}>} controlsByName
 * @param {{value: string | null} | {value: {name: string, path: string[]} | null}} inEventsForRef
 * @returns {void}
 */
function parseCommonTagBlocks(
	lines,
	startLine,
	endLine,
	rangeLines,
	ensureGroup,
	controlsByName,
	inEventsForRef
) {
	let currentBlock = null;
	const isHierarchical = Array.isArray(controlsByName);

	for (let i = startLine; i <= endLine; i++) {
		const line = lines[i];

		// #tag Events block (window files only)
		const eventsBegin =
			/^\s*#tag\s+Events\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(line);
		if (eventsBegin) {
			if (isHierarchical) {
				// Find control with matching name, prefer shortest path (closest scope)
				const targetName = eventsBegin[1];
				const candidates = controlsByName.filter(c => c.name === targetName);
				if (candidates.length > 0) {
					candidates.sort((a, b) => a.path.length - b.path.length);
					inEventsForRef.value = { name: targetName, path: candidates[0].path };
				} else {
					inEventsForRef.value = null;
				}
			} else {
				inEventsForRef.value = eventsBegin[1];
			}
			continue;
		}
		if (/^\s*#tag\s+EndEvents\b/i.test(line)) {
			inEventsForRef.value = null;
			continue;
		}

		// Start of blocks
		if (/^\s*#tag\s+Event\b/i.test(line)) {
			currentBlock = { type: "Event", startLine: i };
			continue;
		}
		if (/^\s*#tag\s+Method\b/i.test(line)) {
			currentBlock = { type: "Method", startLine: i };
			continue;
		}
		if (/^\s*#tag\s+MenuHandler\b/i.test(line)) {
			currentBlock = { type: "Method", startLine: i };
			continue;
		}
		if (/^\s*#tag\s+Property\b/i.test(line)) {
			currentBlock = { type: "Property", startLine: i };
			continue;
		}
		if (/^\s*#tag\s+Constant\b/i.test(line)) {
			currentBlock = { type: "Constant", startLine: i };
			continue;
		}

		// End of Event block
		if (
			/^\s*#tag\s+EndEvent\b/i.test(line) &&
			currentBlock?.type === "Event"
		) {
			for (let j = currentBlock.startLine; j <= i; j++) {
				const m =
					/^(?:\s*)(sub|function)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:as\s+([A-Za-z_][A-Za-z0-9_<>]*))?/i.exec(
						lines[j]
					);
				if (m) {
					const name = m[2];
					const params = (m[3] || "").trim();
					const ret = (m[4] || "").trim();
					const detail = `(${params})${ret ? " As " + ret : ""}`;
					const sym = new vscode.DocumentSymbol(
						name,
						detail,
						vscode.SymbolKind.Event,
						rangeLines(j, i),
						rangeLines(j, j)
					);
					// Add to control if in Events block, otherwise to Event Handlers group
					if (inEventsForRef.value) {
						if (isHierarchical) {
							// Find control by name and path
							const target = inEventsForRef.value;
							const control = controlsByName.find(
								c => c.name === target.name &&
								JSON.stringify(c.path) === JSON.stringify(target.path)
							);
							if (control) {
								control.symbol.children.push(sym);
							} else {
								ensureGroup("Event Handlers").children.push(sym);
							}
						} else {
							// Legacy flat structure
							if (controlsByName[inEventsForRef.value]) {
								controlsByName[inEventsForRef.value].children.push(sym);
							} else {
								ensureGroup("Event Handlers").children.push(sym);
							}
						}
					} else {
						ensureGroup("Event Handlers").children.push(sym);
					}
					break;
				}
			}
			currentBlock = null;
			continue;
		}

		// End of Method block
		if (
			(/^\s*#tag\s+EndMethod\b/i.test(line) ||
				/^\s*#tag\s+EndMenuHandler\b/i.test(line)) &&
			currentBlock?.type === "Method"
		) {
			for (let j = currentBlock.startLine; j <= i; j++) {
				const m =
					/^(?:\s*)(sub|function)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:as\s+([A-Za-z_][A-Za-z0-9_<>]*))?/i.exec(
						lines[j]
					);
				if (m) {
					const hasHandles = /\bHandles\b/i.test(lines[j]);
					const kind =
						m[1].toLowerCase() === "sub"
							? vscode.SymbolKind.Method
							: vscode.SymbolKind.Function;
					const name = m[2];
					const params = (m[3] || "").trim();
					const ret = (m[4] || "").trim();
					const detail = `(${params})${ret ? " As " + ret : ""}`;
					const sym = new vscode.DocumentSymbol(
						name,
						detail,
						hasHandles ? vscode.SymbolKind.Event : kind,
						rangeLines(j, i),
						rangeLines(j, j)
					);
					const groupName = hasHandles ? "MenuHandlers" : "Methods";
					ensureGroup(groupName).children.push(sym);
					break;
				}
			}
			currentBlock = null;
			continue;
		}

		// End of Property block
		if (
			/^\s*#tag\s+EndProperty\b/i.test(line) &&
			currentBlock?.type === "Property"
		) {
			for (let j = currentBlock.startLine; j <= i; j++) {
				const m =
					/^\s*(?:Private|Public|Protected)?\s*([A-Za-z_][A-Za-z0-9_]*)\s+As\s+([A-Za-z_][A-Za-z0-9_<>]*)/i.exec(
						lines[j]
					);
				if (m) {
					const sym = new vscode.DocumentSymbol(
						m[1],
						`As ${m[2]}`,
						vscode.SymbolKind.Property,
						rangeLines(j, j),
						rangeLines(j, j)
					);
					ensureGroup("Properties").children.push(sym);
				}
			}
			currentBlock = null;
			continue;
		}

		// End of Constant block
		if (
			/^\s*#tag\s+EndConstant\b/i.test(line) &&
			currentBlock?.type === "Constant"
		) {
			const openLine = lines[currentBlock.startLine] || "";
			const nameMatch = /Name\s*=\s*([^,]+)/i.exec(openLine);
			const typeMatch = /Type\s*=\s*([^,]+)/i.exec(openLine);
			const name = nameMatch
				? nameMatch[1].trim().replace(/^"|"$/g, "")
				: "Constant";
			const ctype = typeMatch
				? typeMatch[1].trim().replace(/^"|"$/g, "")
				: "";
			const sym = new vscode.DocumentSymbol(
				name,
				ctype ? `As ${ctype}` : "Constant",
				vscode.SymbolKind.Constant,
				rangeLines(currentBlock.startLine, i),
				rangeLines(currentBlock.startLine, currentBlock.startLine)
			);
			ensureGroup("Constants").children.push(sym);
			currentBlock = null;
			continue;
		}

		// Skip free-form detection if inside a block
		if (currentBlock) {
			continue;
		}

		// Free-form Property detection
		const pm =
			/^\s*(?:Private|Public|Protected)?\s*([A-Za-z_][A-Za-z0-9_]*)\s+As\s+([A-Za-z_][A-Za-z0-9_<>]*)\s*$/i.exec(
				line
			);
		if (pm) {
			const sym = new vscode.DocumentSymbol(
				pm[1],
				`As ${pm[2]}`,
				vscode.SymbolKind.Property,
				rangeLines(i, i),
				rangeLines(i, i)
			);
			ensureGroup("Properties").children.push(sym);
			continue;
		}

		// Free-form Method/Function detection
		const mm =
			/^\s*(?:Private|Public|Protected)?\s*(sub|function)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:as\s+([A-Za-z_][A-Za-z0-9_<>]*))?/i.exec(
				line
			);
		if (mm) {
			const hasHandles = /\bHandles\b/i.test(line);
			const kind =
				mm[1].toLowerCase() === "sub"
					? vscode.SymbolKind.Method
					: vscode.SymbolKind.Function;
			const name = mm[2];
			const params = (mm[3] || "").trim();
			const ret = (mm[4] || "").trim();
			const detail = `(${params})${ret ? " As " + ret : ""}`;
			const sym = new vscode.DocumentSymbol(
				name,
				detail,
				hasHandles ? vscode.SymbolKind.Event : kind,
				rangeLines(i, i),
				rangeLines(i, i)
			);
			const groupName = hasHandles ? "MenuHandlers" : "Methods";
			ensureGroup(groupName).children.push(sym);
			continue;
		}
	}
}

/**
 * Generic Sub/Function/Method/Event/Delegate symbol extraction for plain code files.
 * @param {vscode.TextDocument} document
 * @param {string} text
 */
function parseGenericFunctionSymbols(document, text) {
	const symbols = [];
	const declRe =
		/^(\s*)(?:(?:private|public|protected|global)\s+)?(sub|function|method|event|delegate)\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\(([^)]*)\)\s*(?:as\s+([A-Za-z_][A-Za-z0-9_<>]*))?/gim;
	let match;
	while ((match = declRe.exec(text)) !== null) {
		const full = match[0];
		const indent = match[1] || "";
		const kindStr = match[2];
		const name = match[3];
		const params = match[4] || "";
		const ret = match[5] || "";

		const startOffset = match.index + indent.length;
		const startPos = document.positionAt(startOffset);
		const kindLower = kindStr.toLowerCase();
		const endRe = new RegExp("^\\s*end\\s+" + kindLower + "\\b", "im");
		const rest = text.slice(match.index + full.length);
		const endMatch = endRe.exec(rest);
		const endOffset = endMatch
			? match.index + full.length + endMatch.index + endMatch[0].length
			: match.index + full.length;
		const endPos = document.positionAt(endOffset);

		const detail =
			(params.trim().length > 0 ? `(${params.trim()})` : `()`) +
			(ret ? " As " + ret : "");

		let symbolKind = vscode.SymbolKind.Function;
		if (kindLower === "sub" || kindLower === "method")
			symbolKind = vscode.SymbolKind.Method;
		else if (kindLower === "event") symbolKind = vscode.SymbolKind.Event;
		else if (kindLower === "delegate")
			symbolKind = vscode.SymbolKind.Interface;

		const symbol = new vscode.DocumentSymbol(
			name,
			`${kindStr} ${detail}`,
			symbolKind,
			new vscode.Range(startPos, endPos),
			new vscode.Range(startPos, startPos)
		);
		symbols.push(symbol);
	}
	return symbols;
}

/**
 * Object type definition table for Xojo code objects (Class, Module, Interface, Structure, Enum)
 */
const XOJO_OBJECT_TYPES = {
	Class: {
		tagName: "Class",
		symbolKind: vscode.SymbolKind.Class,
		keywords: ["Class"],
		groups: ["Methods", "Properties", "Event Handlers", "Constants", "MenuHandlers"]
	},
	Module: {
		tagName: "Module",
		symbolKind: vscode.SymbolKind.Module,
		keywords: ["Module"],
		groups: ["Methods", "Properties", "Constants"]
	},
	Interface: {
		tagName: "Interface",
		symbolKind: vscode.SymbolKind.Interface,
		keywords: ["Interface"],
		groups: ["Methods", "Properties"]
	},
	Structure: {
		tagName: "Structure",
		symbolKind: vscode.SymbolKind.Struct,
		keywords: ["Structure"],
		groups: ["Properties"]
	},
	Enum: {
		tagName: "Enum",
		symbolKind: vscode.SymbolKind.Enum,
		keywords: ["Enum"],
		groups: []
	}
};

/**
 * Parse Xojo .xojo_code file and build hierarchical symbols for Class/Module/Interface/Structure/Enum.
 * Detects object type from #tag or free-form declaration and applies appropriate group structure.
 * @param {vscode.TextDocument} document
 * @param {string} text
 */
function parseXojoObjectSymbols(document, text) {
	const lines = text.split(/\r?\n/);
	const L = lines.length;

	const rangeLines = (startLine, endLine) =>
		new vscode.Range(
			new vscode.Position(startLine, 0),
			new vscode.Position(endLine, (lines[endLine] || "").length)
		);

	/** @type {vscode.DocumentSymbol[]} */
	const result = [];

	// 1) Detect object type, name, and range
	let objectType = "Class"; // default
	let objectName = "Object";
	let objectStart = 0;
	let objectEnd = L - 1;

	for (let i = 0; i < L; i++) {
		// Check for #tag <ObjectType>
		for (const [typeName, config] of Object.entries(XOJO_OBJECT_TYPES)) {
			const tagPattern = new RegExp(`^\\s*#tag\\s+${config.tagName}\\b`, "i");
			if (tagPattern.test(lines[i])) {
				objectType = typeName;
				objectStart = i;
				// Scan next few lines for actual declaration
				for (let j = i; j < Math.min(i + 10, L); j++) {
					const declPattern = new RegExp(
						`^\\s*(?:Private|Public|Protected)?\\s*(${config.keywords.join("|")})\\s+([A-Za-z_][A-Za-z0-9_]*)`,
						"i"
					);
					const m = declPattern.exec(lines[j]);
					if (m) {
						objectName = m[2];
						break;
					}
				}
				break;
			}
		}
		if (objectType !== "Class" || objectStart !== 0) break;

		// Fallback: free-form declaration
		for (const [typeName, config] of Object.entries(XOJO_OBJECT_TYPES)) {
			const declPattern = new RegExp(
				`^\\s*(?:Private|Public|Protected)?\\s*(${config.keywords.join("|")})\\s+([A-Za-z_][A-Za-z0-9_]*)`,
				"i"
			);
			const m = declPattern.exec(lines[i]);
			if (m) {
				objectType = typeName;
				objectName = m[2];
				objectStart = i;
				break;
			}
		}
		if (objectType !== "Class" || objectStart !== 0) break;
	}

	// Find end tag
	const endTagPattern = new RegExp(`^\\s*#tag\\s+End${XOJO_OBJECT_TYPES[objectType].tagName}\\b`, "i");
	for (let i = L - 1; i >= 0; i--) {
		if (endTagPattern.test(lines[i])) {
			objectEnd = i;
			break;
		}
	}

	const objectSymbol = new vscode.DocumentSymbol(
		objectName,
		objectType,
		XOJO_OBJECT_TYPES[objectType].symbolKind,
		rangeLines(objectStart, objectEnd),
		rangeLines(objectStart, objectStart)
	);
	result.push(objectSymbol);

	// Lazy group creation based on object type
	/** @type {Record<string, vscode.DocumentSymbol | null>} */
	const groupInstances = {};

	const ensureGroup = (label) => {
		if (!XOJO_OBJECT_TYPES[objectType].groups.includes(label)) {
			return objectSymbol; // Not supported for this object type
		}
		if (!groupInstances[label]) {
			groupInstances[label] = new vscode.DocumentSymbol(
				label,
				"",
				vscode.SymbolKind.Namespace,
				rangeLines(objectStart, objectEnd),
				rangeLines(objectStart, objectStart)
			);
			objectSymbol.children.push(groupInstances[label]);
		}
		return groupInstances[label];
	};

	// Parse #tag blocks using common function
	const inEventsForRef = { value: null };
	parseCommonTagBlocks(
		lines,
		0, // Scan entire file
		L - 1,
		rangeLines,
		ensureGroup,
		{}, // No controls in code files
		inEventsForRef
	);
	return result;
}
/**
 * Parse Xojo .xojo_window file with #tag structure to produce hierarchical symbols.
 * @param {vscode.TextDocument} document
 * @param {string} text
 */
function parseXojoWindowSymbols(document, text) {
	const lines = text.split(/\r?\n/);
	const L = lines.length;

	const pos = (line, col = 0) =>
		new vscode.Position(
			Math.max(0, Math.min(L - 1, line)),
			Math.max(0, col)
		);
	const rangeLines = (startLine, endLine) =>
		new vscode.Range(
			pos(startLine, 0),
			pos(endLine, (lines[endLine] || "").length)
		);

	/** @type {vscode.DocumentSymbol[]} */
	const result = [];

	// Detect window/class name (DesktopWindow or Window)
	let windowName = "Window";
	let windowStart = 0;
	let windowEnd = L - 1;
	for (let i = 0; i < L; i++) {
		const m =
			/^\s*Begin\s+(?:DesktopWindow|Window)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(
				lines[i]
			);
		if (m) {
			windowName = m[1];
			windowStart = i;
			break;
		}
	}

	// Try to find the matching End for the window block to set a better range
	// We treat only bare "End" lines as block terminators (avoid "End Sub" etc.)
	{
		const beginRe =
			/^\s*(?:Begin\s+|BeginDesktop[A-Za-z]+\s+)([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)/i;
		/** @type {Array<{type:string,name:string}>} */
		const stack = [];
		for (let i = windowStart; i < L; i++) {
			const line = lines[i];
			const bm = beginRe.exec(line);
			if (bm) {
				stack.push({ type: bm[1], name: bm[2] });
				continue;
			}
			if (/^\s*End\s*$/i.test(line) && stack.length) {
				const closed = stack.pop();
				if (/^(?:DesktopWindow|Window)$/i.test(closed.type)) {
					windowEnd = i;
					break;
				}
			}
		}
	}

	const windowSymbol = new vscode.DocumentSymbol(
		windowName,
		"DesktopWindow",
		vscode.SymbolKind.Class,
		rangeLines(windowStart, windowEnd),
		rangeLines(windowStart, windowStart)
	);
	result.push(windowSymbol);

	// Lazy groups under window root
	/** @type {vscode.DocumentSymbol | null} */
	let controlsGroup = null;
	/** @type {vscode.DocumentSymbol | null} */
	let eventsGroup = null;
	/** @type {vscode.DocumentSymbol | null} */
	let methodsGroup = null;
	/** @type {vscode.DocumentSymbol | null} */
	let menuHandlersGroup = null;
	/** @type {vscode.DocumentSymbol | null} */
	let propertiesGroup = null;
	/** @type {vscode.DocumentSymbol | null} */
	let constantsGroupWin = null;

	const ensureGroup = (label) => {
		if (label === "Controls") {
			if (!controlsGroup) {
				controlsGroup = new vscode.DocumentSymbol(
					"Controls",
					"",
					vscode.SymbolKind.Namespace,
					rangeLines(windowStart, windowEnd),
					rangeLines(windowStart, windowStart)
				);
				windowSymbol.children.push(controlsGroup);
			}
			return controlsGroup;
		}
		if (label === "Event Handlers") {
			if (!eventsGroup) {
				eventsGroup = new vscode.DocumentSymbol(
					"Event Handlers",
					"",
					vscode.SymbolKind.Namespace,
					rangeLines(windowStart, windowEnd),
					rangeLines(windowStart, windowStart)
				);
				windowSymbol.children.push(eventsGroup);
			}
			return eventsGroup;
		}
		if (label === "Methods") {
			if (!methodsGroup) {
				methodsGroup = new vscode.DocumentSymbol(
					"Methods",
					"",
					vscode.SymbolKind.Namespace,
					rangeLines(windowStart, windowEnd),
					rangeLines(windowStart, windowStart)
				);
				windowSymbol.children.push(methodsGroup);
			}
			return methodsGroup;
		}
		if (label === "MenuHandlers") {
			if (!menuHandlersGroup) {
				menuHandlersGroup = new vscode.DocumentSymbol(
					"MenuHandlers",
					"",
					vscode.SymbolKind.Namespace,
					rangeLines(windowStart, windowEnd),
					rangeLines(windowStart, windowStart)
				);
				windowSymbol.children.push(menuHandlersGroup);
			}
			return menuHandlersGroup;
		}
		if (label === "Properties") {
			if (!propertiesGroup) {
				propertiesGroup = new vscode.DocumentSymbol(
					"Properties",
					"",
					vscode.SymbolKind.Namespace,
					rangeLines(windowStart, windowEnd),
					rangeLines(windowStart, windowStart)
				);
				windowSymbol.children.push(propertiesGroup);
			}
			return propertiesGroup;
		}
		if (label === "Constants") {
			if (!constantsGroupWin) {
				constantsGroupWin = new vscode.DocumentSymbol(
					"Constants",
					"",
					vscode.SymbolKind.Namespace,
					rangeLines(windowStart, windowEnd),
					rangeLines(windowStart, windowStart)
				);
				windowSymbol.children.push(constantsGroupWin);
			}
			return constantsGroupWin;
		}
		return windowSymbol;
	};

	// Parse controls and add them under Controls group
	/** @type {Array<{name: string, path: string[], symbol: vscode.DocumentSymbol}>} */
	const controlsByName = [];
	/** @type {Array<{name: string, parent: string | null, symbol: vscode.DocumentSymbol}>} */
	const controlsList = [];
	{
		const beginCtrlRe =
			/^\s*(?:Begin\s+|BeginDesktop[A-Za-z]+\s+)([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)/i;
		for (let i = 0; i < L; i++) {
			const bm = beginCtrlRe.exec(lines[i]);
			if (!bm) continue;
			const type = bm[1];
			const name = bm[2];
			if (/^(?:DesktopWindow|Window)$/i.test(type)) continue; // skip root window in controls list

			// find matching bare End for this control
			let endLine = i;
			let depth = 1;
			let initialParent = null;

			for (let j = i + 1; j < L; j++) {
				const line = lines[j];
				if (beginCtrlRe.test(line)) {
					// reset regex state and increment depth
					beginCtrlRe.lastIndex = 0;
					depth++;
					continue;
				}
				if (/^\s*End\s*$/i.test(line)) {
					depth--;
					if (depth === 0) {
						endLine = j;
						break;
					}
				}
				// Extract InitialParent attribute
				if (depth === 1) {
					const parentMatch = /^\s*InitialParent\s*=\s*"([^"]*)"/i.exec(line);
					if (parentMatch) {
						const parentValue = parentMatch[1].trim();
						if (parentValue !== "") {
							initialParent = parentValue;
						}
					}
				}
			}

			const sym = new vscode.DocumentSymbol(
				`${name}`,
				type,
				vscode.SymbolKind.Field,
				rangeLines(i, endLine),
				rangeLines(i, i)
			);
			controlsList.push({ name, parent: initialParent, symbol: sym });
		}
	}

	// Build control hierarchy and path map
	/** @type {Map<string, string[]>} */
	const controlPathMap = new Map();

	// Helper to find parent in controlsList
	const findParent = (parentName) => controlsList.find(c => c.name === parentName);

	// Recursive function to build path
	const buildPath = (ctrl, visited = new Set()) => {
		if (controlPathMap.has(ctrl.name)) {
			return controlPathMap.get(ctrl.name);
		}
		if (visited.has(ctrl.name)) {
			// Circular reference, return empty path
			return [ctrl.name];
		}
		visited.add(ctrl.name);

		if (!ctrl.parent) {
			const path = [ctrl.name];
			controlPathMap.set(ctrl.name, path);
			return path;
		}

		const parent = findParent(ctrl.parent);
		if (parent) {
			const parentPath = buildPath(parent, visited);
			const path = [...parentPath, ctrl.name];
			controlPathMap.set(ctrl.name, path);
			return path;
		} else {
			const path = [ctrl.name];
			controlPathMap.set(ctrl.name, path);
			return path;
		}
	};

	// Build paths for all controls
	for (const ctrl of controlsList) {
		buildPath(ctrl);
	}

	// Add controls to hierarchy and populate controlsByName array
	for (const ctrl of controlsList) {
		const path = controlPathMap.get(ctrl.name) || [ctrl.name];
		controlsByName.push({ name: ctrl.name, path, symbol: ctrl.symbol });

		if (ctrl.parent) {
			const parent = findParent(ctrl.parent);
			if (parent) {
				// Add to parent control
				parent.symbol.children.push(ctrl.symbol);
			} else {
				// Parent not found, add to Controls group
				const g = ensureGroup("Controls");
				g.children.push(ctrl.symbol);
			}
		} else {
			// Add to window's Controls group
			const g = ensureGroup("Controls");
			g.children.push(ctrl.symbol);
		}
	}

	// Parse #tag sections using common function
	const inEventsForRef = { value: null };
	parseCommonTagBlocks(
		lines,
		0, // Scan entire file, not just window block
		L - 1,
		rangeLines,
		ensureGroup,
		controlsByName,
		inEventsForRef
	);

	return result;
}

/**
 * Parse Xojo .xojo_menu file to produce hierarchical menu symbols.
 * @param {vscode.TextDocument} document
 * @param {string} text
 */
function parseXojoMenuSymbols(document, text) {
	const lines = text.split(/\r?\n/);
	const L = lines.length;

	const pos = (line, col = 0) =>
		new vscode.Position(
			Math.max(0, Math.min(L - 1, line)),
			Math.max(0, col)
		);
	const rangeLines = (startLine, endLine) =>
		new vscode.Range(
			pos(startLine, 0),
			pos(endLine, (lines[endLine] || "").length)
		);

	/** @type {vscode.DocumentSymbol[]} */
	const result = [];

	// Menu item type to SymbolKind mapping
	const menuItemKindMap = {
		'Menu': vscode.SymbolKind.Namespace,
		'DesktopMenuItem': vscode.SymbolKind.Field,
		'DesktopQuitMenuItem': vscode.SymbolKind.Event,
		'DesktopApplicationMenuItem': vscode.SymbolKind.Field,
		'DesktopPreferencesMenuItem': vscode.SymbolKind.Field,
		'DesktopMenuBar': vscode.SymbolKind.Namespace
	};

	// Detect root menu name
	let menuName = "Menu";
	let menuStart = 0;
	let menuEnd = L - 1;

	for (let i = 0; i < L; i++) {
		const m = /^\s*Begin\s+Menu\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(lines[i]);
		if (m) {
			menuName = m[1];
			menuStart = i;
			break;
		}
	}

	// Find menu end (look for #tag EndMenu or the outermost End)
	let depth = 0;
	for (let i = menuStart; i < L; i++) {
		if (/^\s*#tag\s+EndMenu\b/i.test(lines[i])) {
			menuEnd = i;
			break;
		}
		if (/^\s*Begin\s+/i.test(lines[i])) {
			depth++;
		} else if (/^\s*End\s*$/i.test(lines[i])) {
			depth--;
			if (depth === 0) {
				menuEnd = i;
				break;
			}
		}
	}

	const rootSymbol = new vscode.DocumentSymbol(
		menuName,
		"Menu",
		vscode.SymbolKind.Namespace,
		rangeLines(menuStart, menuEnd),
		rangeLines(menuStart, menuStart)
	);
	result.push(rootSymbol);

	// Parse menu items recursively
	const beginRe = /^\s*Begin\s+(Menu|Desktop(?:[A-Za-z]+)?MenuItem|DesktopMenuBar)\s+([A-Za-z_][A-Za-z0-9_]*)/i;

	/**
	 * Recursively parse menu items from startLine to endLine
	 * @param {vscode.DocumentSymbol} parent
	 * @param {number} startLine
	 * @param {number} endLine
	 */
	function parseMenuItems(parent, startLine, endLine) {
		let i = startLine;
		while (i <= endLine) {
			const line = lines[i];
			const bm = beginRe.exec(line);

			if (bm) {
				const type = bm[1];
				const name = bm[2];

				// Skip root Menu block (already processed)
				if (type === 'Menu') {
					i++;
					continue;
				}

				// Find matching End for this item
				let itemEndLine = i;
				let depth = 1;
				let textValue = null;

				for (let j = i + 1; j < L; j++) {
					const innerLine = lines[j];
					const innerMatch = beginRe.exec(innerLine);
					if (innerMatch) {
						beginRe.lastIndex = 0;
						depth++;
					} else if (/^\s*End\s*$/i.test(innerLine)) {
						depth--;
						if (depth === 0) {
							itemEndLine = j;
							break;
						}
					}
					// Extract Text attribute (only at depth 1)
					if (depth === 1 && !textValue) {
						const textMatch = /^\s*Text\s*=\s*"([^"]*)"/i.exec(innerLine);
						if (textMatch) {
							textValue = textMatch[1];
						}
					}
				}

				// Determine SymbolKind
				const symbolKind = menuItemKindMap[type] || vscode.SymbolKind.Field;

				// Check if separator
				const isSeparator = textValue === "-";
				const detail = isSeparator ? "Separator" : (textValue || type);

				const sym = new vscode.DocumentSymbol(
					name,
					detail,
					isSeparator ? vscode.SymbolKind.Null : symbolKind,
					rangeLines(i, itemEndLine),
					rangeLines(i, i)
				);

				// Add to parent
				parent.children.push(sym);

				// Recursively parse children (from i+1 to itemEndLine-1)
				if (itemEndLine > i + 1) {
					parseMenuItems(sym, i + 1, itemEndLine - 1);
				}

				// Move to next item (after End)
				i = itemEndLine + 1;
			} else {
				// Skip non-Begin lines
				i++;
			}
		}
	}

	// Start parsing from root menu's children
	if (menuEnd > menuStart + 1) {
		parseMenuItems(rootSymbol, menuStart + 1, menuEnd - 1);
	}

	return result;
}
