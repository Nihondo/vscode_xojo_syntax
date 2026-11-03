// Source offsets are UTF-16 offsets, as used by TextDocument.positionAt.
const IDENTIFIER = "[A-Za-z_][A-Za-z0-9_\\u0080-\\uFFFF]*";
const QUALIFIED_NAME = `${IDENTIFIER}(?:\\.${IDENTIFIER})*`;
const MODIFIERS = "(?:(?:Private|Public|Protected|Global|Shared|Static)\\s+)*";
const OBJECT_NAMES = ["Class", "Module", "Interface", "Structure", "Enum"];
const OPAQUE_TAGS = new Set(["note", "viewbehavior", "viewproperty", "enumvalues"]);
const MEMBER_TAGS = new Set([
	"method", "menuhandler", "event", "hook", "property", "computedproperty",
	"constant", "delegatedeclaration", "declaredeclaration", "externalmethod",
]);

const XOJO_OBJECT_TYPES = Object.fromEntries(OBJECT_NAMES.map(name => [name.toLowerCase(), {
	name,
	kind: ({ Class: "Class", Module: "Module", Interface: "Interface", Structure: "Struct", Enum: "Enum" })[name],
	groups: name === "Enum" ? [] : name === "Structure" ? ["Properties"] :
		["Methods", "Properties", "Events", "Event Handlers", "Constants", "MenuHandlers", "Delegates", "Enums", "Structures"],
}]));

/** Mask strings/comments without changing source positions. Backslashes are ordinary Xojo characters. */
function maskLine(text) {
	const code = text.split("");
	let comment = text.length;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '"') {
			code[i] = " ";
			while (++i < text.length) {
				code[i] = " ";
				if (text[i] === '"') {
					if (text[i + 1] === '"') code[++i] = " ";
					else break;
				}
			}
		} else if (text[i] === "'" || text.slice(i, i + 2) === "//" ||
			(/^Rem(?=\s|$)/i.test(text.slice(i)) && (i === 0 || /[\s:]/.test(text[i - 1])))) {
			comment = i;
			break;
		}
	}
	return {
		code: code.slice(0, comment).join("") + " ".repeat(text.length - comment),
		content: text.slice(0, comment) + " ".repeat(text.length - comment),
	};
}

/** Parse a complete logical declaration, retaining its original parameter text. */
function parseDeclaration(statement) {
	const { code, content, start } = statement;
	const routine = new RegExp(`^\\s*(${MODIFIERS})(?:(Delegate)\\s+)?(?:(Soft\\s+)?(Declare)\\s+)?(Sub|Function|Method|Event)\\s+(${QUALIFIED_NAME})`, "i").exec(code);
	if (routine) {
		const name = routine[6];
		const nameIndex = routine[0].length - name.length;
		const open = code.indexOf("(", routine[0].length);
		let close = -1;
		if (open >= 0) {
			let depth = 0;
			for (let i = open; i < code.length; i++) {
				if (code[i] === "(") depth++;
				if (code[i] === ")" && --depth === 0) { close = i; break; }
			}
		}
		const tailStart = open < 0 ? routine[0].length : close < 0 ? code.length : close + 1;
		const typeMatch = /\bAs\s+([\s\S]*?)(?=\s+(?:Handles|Implements)\b|$)/i.exec(code.slice(tailStart));
		return {
			kind: routine[2] ? "delegate" : routine[4] ? "declare" : routine[5].toLowerCase(),
			routineKind: routine[5].toLowerCase(), name,
			nameStart: start + nameIndex, nameEnd: start + nameIndex + name.length,
			modifiers: routine.slice(1, 5).filter(Boolean).join(" ").trim().replace(/\s+/g, " "),
			params: open < 0 ? "" : content.slice(open + 1, close < 0 ? content.length : close).trim(),
			returnType: typeMatch ? typeMatch[1].trim().replace(/\s+/g, " ") : "",
			hasHandles: /\bHandles\b/i.test(code.slice(tailStart)),
		};
	}
	const object = new RegExp(`^\\s*(${MODIFIERS})(Class|Module|Interface|Structure|Enum)\\s+(${IDENTIFIER})`, "i").exec(code);
	if (object) {
		const nameIndex = object[0].length - object[3].length;
		return { kind: "object", objectType: object[2].toLowerCase(), name: object[3],
			nameStart: start + nameIndex, nameEnd: start + nameIndex + object[3].length };
	}
	const constant = new RegExp(`^\\s*${MODIFIERS}Const\\s+(${IDENTIFIER})`, "i").exec(code);
	if (constant) {
		const nameIndex = constant[0].length - constant[1].length;
		return { kind: "constant", name: constant[1], nameStart: start + nameIndex,
			nameEnd: start + nameIndex + constant[1].length, detail: content.slice(constant[0].length).trim() };
	}
	const property = new RegExp(`^\\s*(${MODIFIERS})(?:Property\\s+)?(${IDENTIFIER})\\s*(\\([^)]*\\))?\\s+As\\s+([^=]+)`, "i").exec(code);
	if (property) {
		const nameIndex = code.indexOf(property[2], property[1].length + code.search(/\S/));
		return { kind: "property", name: property[2], nameStart: start + nameIndex,
			nameEnd: start + nameIndex + property[2].length,
			detail: `${property[3] || ""} As ${property[4].trim()}`.trim(), modifiers: property[1].trim() };
	}
	return null;
}

function tagAttributes(header, offset) {
	const result = {};
	const re = /(?:^|,)\s*([A-Za-z]+)\s*=\s*("(?:""|[^"\r\n])*"|[^,\r\n]+)/g;
	let match;
	while ((match = re.exec(header))) {
		const value = match[2].trim();
		const quoted = value.startsWith('"');
		const index = match.index + match[0].indexOf("=") + 1 + match[0].split("=").slice(1).join("=").search(/\S/);
		result[match[1].toLowerCase()] = {
			value: quoted ? value.slice(1, -1).replace(/""/g, '"') : value,
			start: offset + index + (quoted ? 1 : 0), end: offset + index + value.length - (quoted ? 1 : 0),
		};
	}
	return result;
}

/** Scan lexical, tag and physical code structure once for Outline and folding. */
function scanXojoSource(text) {
	const lines = [];
	const lineRe = /([^\r\n]*)(\r\n|\r|\n|$)/g;
	let match;
	while ((match = lineRe.exec(text))) {
		const lexical = maskLine(match[1]);
		lines.push({ text: match[1], ending: match[2], start: match.index, ...lexical });
		if (!match[2]) break;
	}
	const statements = [];
	for (let i = 0; i < lines.length; i++) {
		const first = i;
		let content = "", code = "";
		while (true) {
			const line = lines[i];
			const continuation = /(?:^|\s)(_)[ \t]*$/.exec(line.code);
			const index = continuation ? line.code.lastIndexOf("_") : -1;
			const removeContinuation = value => index < 0 ? value : value.slice(0, index) + " " + value.slice(index + 1);
			content += removeContinuation(line.content);
			code += removeContinuation(line.code);
			if (!continuation || i + 1 >= lines.length) break;
			content += line.ending;
			code += line.ending;
			i++;
		}
		statements.push({ start: lines[first].start, end: lines[i].start + lines[i].text.length,
			startLine: first, endLine: i, content, code });
	}
	const tags = [], blocks = [], tagStack = [], codeStack = [];
	const finish = (block, line, closed) => {
		block.endLine = Math.max(block.startLine, line);
		block.end = lines[block.endLine].start + lines[block.endLine].text.length;
		block.closed = closed;
	};
	const closeCode = (type, statement) => {
		let index = codeStack.length - 1;
		if (type) while (index >= 0 && codeStack[index].type !== type) index--;
		if (index < 0) return;
		while (codeStack.length > index) {
			const block = codeStack.pop();
			finish(block, statement.startLine - (codeStack.length === index ? 0 : 1), codeStack.length === index);
		}
	};
	for (const statement of statements) {
		const trimmed = statement.code.trim();
		const tagMatch = /^#tag\s+(\w+)/i.exec(trimmed);
		const opaqueNote = tagStack.find(t => t.type === "note");
		if (opaqueNote && (!tagMatch || tagMatch[1].toLowerCase() !== "endnote")) {
			statement.tag = tagStack[tagStack.length - 1];
			continue;
		}
		if (tagMatch) {
			const type = tagMatch[1].toLowerCase();
			if (type.startsWith("end")) {
				const target = type.slice(3);
				let index = tagStack.length - 1;
				while (index >= 0 && tagStack[index].type !== target) index--;
				if (index >= 0) {
					const closing = new Set(tagStack.slice(index));
					while (codeStack.length && closing.has(codeStack[codeStack.length - 1].tag)) finish(codeStack.pop(), statement.startLine - 1, false);
					while (tagStack.length > index) {
						const tag = tagStack.pop();
						finish(tag, statement.startLine - (tagStack.length === index ? 0 : 1), tagStack.length === index);
					}
				}
			} else {
				// A new member starts a sibling even if the previous member is unfinished.
				if (MEMBER_TAGS.has(type) || XOJO_OBJECT_TYPES[type]) {
					const index = tagStack.findIndex(tag => MEMBER_TAGS.has(tag.type));
					if (index >= 0) {
						const closing = new Set(tagStack.slice(index));
						while (codeStack.length && closing.has(codeStack[codeStack.length - 1].tag)) finish(codeStack.pop(), statement.startLine - 1, false);
						while (tagStack.length > index) finish(tagStack.pop(), statement.startLine - 1, false);
					}
				}
				const tag = { type, start: statement.start, startLine: statement.startLine,
					parent: tagStack[tagStack.length - 1], children: [], header: statement.content,
					attributes: tagAttributes(statement.content, statement.start) };
				if (tag.parent) tag.parent.children.push(tag);
				tags.push(tag);
				tagStack.push(tag);
			}
			continue;
		}
		statement.tag = tagStack[tagStack.length - 1];
		statement.codeParent = codeStack[codeStack.length - 1];
		if (tagStack.some(t => OPAQUE_TAGS.has(t.type))) continue;
		const declaration = parseDeclaration(statement);
		statement.declaration = declaration;
		let type = null, begin = null;
		if (/^#End\s*If\b/i.test(trimmed)) closeCode("#if", statement);
		else if (/^End(?:\s|$)/i.test(trimmed)) {
			const endType = /^End\s+(\w+)/i.exec(trimmed)?.[1]?.toLowerCase();
			closeCode(endType || null, statement);
		} else if (/^Next\b/i.test(trimmed)) closeCode("for", statement);
		else if (/^Wend\b/i.test(trimmed)) closeCode("while", statement);
		else if (/^Loop\b/i.test(trimmed)) closeCode("do", statement);
		else if (declaration?.kind === "object") type = declaration.objectType;
		else if (declaration && ["sub", "function", "method"].includes(declaration.kind)) {
			const inInterface = tagStack.some(t => t.type === "interface") || codeStack.some(b => b.type === "interface");
			if (!inInterface) {
				const previous = codeStack[codeStack.length - 1];
				if (previous?.tag === statement.tag && ["sub", "function", "method"].includes(previous?.type)) {
					finish(codeStack.pop(), statement.startLine - 1, false);
					statement.codeParent = codeStack[codeStack.length - 1];
				}
				type = declaration.kind;
			}
		} else if ((begin = new RegExp(`^\\s*Begin\\s+(${QUALIFIED_NAME})\\s+(${IDENTIFIER})`, "i").exec(statement.code))) type = "begin";
		else if (/^#?If\s+/i.test(trimmed)) {
			const then = /\bThen\b/i.exec(statement.code);
			if (!then || !statement.content.slice(then.index + then[0].length).trim()) type = trimmed.startsWith("#") ? "#if" : "if";
		} else if (/^Select\s+Case\b/i.test(trimmed)) type = "select";
		else if (/^Try\s*$/i.test(trimmed)) type = "try";
		else if (/^For\s+/i.test(trimmed)) type = "for";
		else if (/^While\s+/i.test(trimmed)) type = "while";
		else if (/^Do(?:\s|$)/i.test(trimmed)) type = "do";
		else if (/^(Get|Set)\s*$/i.test(trimmed)) type = trimmed.toLowerCase();
		if (type) {
			const block = { type, start: statement.start, startLine: statement.startLine,
				tag: statement.tag, parent: statement.codeParent, declaration, statement };
			if (begin) {
				block.uiType = begin[1]; block.name = begin[2];
				block.nameStart = statement.start + begin[0].length - begin[2].length;
			}
			blocks.push(block);
			codeStack.push(block);
			statement.block = block;
		}
	}
	while (tagStack.length) finish(tagStack.pop(), lines.length - 1, false);
	while (codeStack.length) finish(codeStack.pop(), lines.length - 1, false);
	return { text, lines, statements, tags, blocks };
}

function model(name, detail, kind, region, selection) {
	return { name, detail, kind, start: region.start, end: region.end,
		selectionStart: selection?.nameStart ?? region.start,
		selectionEnd: selection?.nameEnd ?? region.start, children: [] };
}

function routineSymbol(declaration, region) {
	const kind = declaration.kind === "delegate" ? "Interface" : declaration.kind === "event" || declaration.hasHandles ? "Event" : declaration.routineKind === "sub" ? "Method" : "Function";
	const detail = `${declaration.modifiers ? declaration.modifiers + " " : ""}(${declaration.params})${declaration.returnType ? " As " + declaration.returnType : ""}`;
	return model(declaration.name, detail, kind, region, declaration);
}

function addGrouped(parent, label, symbol, objectType) {
	if (objectType && !XOJO_OBJECT_TYPES[objectType].groups.includes(label)) parent.children.push(symbol);
	else {
		let group = parent.children.find(s => s.kind === "Namespace" && s.name === label);
		if (!group) {
			group = model(label, "", "Namespace", parent);
			group.isGroup = true;
			parent.children.push(group);
		}
		group.children.push(symbol);
	}
}

function addDeclaration(parent, statement, region, objectType, context) {
	const declaration = statement.declaration;
	if (!declaration || declaration.kind === "object") return;
	let symbol, group;
	if (declaration.kind === "property" || declaration.kind === "constant") {
		symbol = model(declaration.name, declaration.detail || "", declaration.kind === "property" ? "Property" : "Constant", region, declaration);
		group = declaration.kind === "property" ? "Properties" : "Constants";
	} else {
		symbol = routineSymbol(declaration, region);
		group = declaration.kind === "delegate" ? "Delegates" : declaration.kind === "event" ? "Events" : declaration.hasHandles ? "MenuHandlers" : "Methods";
		if (context?.eventHandler) {
			symbol.kind = "Event";
			if (context.control) { context.control.children.push(symbol); return symbol; }
			group = "Event Handlers";
		}
	}
	addGrouped(parent, group, symbol, objectType);
	return symbol;
}

function objectSymbol(analysis, region, type, declaration) {
	const attribute = region.attributes?.name;
	const selection = declaration || (attribute && { nameStart: attribute.start, nameEnd: attribute.end });
	const symbol = model(declaration?.name || attribute?.value || XOJO_OBJECT_TYPES[type].name,
		XOJO_OBJECT_TYPES[type].name, XOJO_OBJECT_TYPES[type].kind, region, selection);
	if (type === "enum") {
		for (const statement of analysis.statements) {
			if (statement.start < region.start || statement.end > region.end || statement.declaration) continue;
			if (region.attributes ? statement.tag !== region : statement.codeParent !== region) continue;
			const value = new RegExp(`^\\s*(${IDENTIFIER})(?:\\s*=.*)?\\s*$`, "i").exec(statement.code);
			if (!value || /^End$/i.test(value[1])) continue;
			const nameStart = statement.start + statement.code.indexOf(value[1]);
			symbol.children.push(model(value[1], statement.content.slice(value[0].indexOf(value[1]) + value[1].length).trim(), "EnumMember", statement,
				{ nameStart, nameEnd: nameStart + value[1].length }));
		}
	} else parseCommonTagBlocks(analysis, symbol, region.attributes ? region : null, type, null,
		region.attributes ? declaration && analysis.blocks.find(b => b.declaration === declaration) : region);
	return symbol;
}

/** Extract semantic members; layout metadata and method bodies remain opaque. */
function parseCommonTagBlocks(analysis, parent, scopeTag, objectType, controls, scopeBlock = null) {
	const visit = (tag, control = null) => {
		if (OPAQUE_TAGS.has(tag.type)) return;
		if (XOJO_OBJECT_TYPES[tag.type]) {
			const declaration = analysis.statements.find(s => s.tag === tag && s.declaration?.kind === "object")?.declaration;
			addGrouped(parent, tag.type === "enum" ? "Enums" : tag.type === "structure" ? "Structures" : "Types", objectSymbol(analysis, tag, tag.type, declaration), objectType);
			return;
		}
		if (tag.type === "events") {
			const name = new RegExp(`^\\s*#tag\\s+Events\\s+(${IDENTIFIER})`, "i").exec(tag.header)?.[1]?.toLowerCase();
			control = controls?.find(c => c.name.toLowerCase() === name)?.symbol || null;
		}
		if (MEMBER_TAGS.has(tag.type)) {
			const declarations = analysis.statements.filter(s => s.tag === tag && s.declaration &&
				(!s.codeParent || s.codeParent.tag !== tag));
			if (tag.type === "constant" && !declarations.length && tag.attributes.name) {
				const name = tag.attributes.name;
				addGrouped(parent, "Constants", model(name.value, tag.attributes.type ? `As ${tag.attributes.type.value}` : "Constant", "Constant", tag,
					{ nameStart: name.start, nameEnd: name.end }), objectType);
			} else {
				for (const statement of declarations) {
					const symbol = addDeclaration(parent, statement, tag, objectType,
						{ eventHandler: tag.type === "event", control });
					if (symbol && tag.type === "computedproperty") {
						for (const accessor of tag.children.filter(t => ["getter", "setter"].includes(t.type))) {
							const keyword = accessor.type === "getter" ? "Get" : "Set";
							const line = analysis.statements.find(s => s.tag === accessor && s.code.trim().toLowerCase() === keyword.toLowerCase());
							const start = line ? line.start + line.code.search(/\S/) : accessor.start;
							symbol.children.push(model(keyword, "", "Method", accessor, { nameStart: start, nameEnd: start + (line ? keyword.length : 0) }));
						}
					}
				}
			}
			return;
		}
		for (const child of tag.children) visit(child, control);
	};
	for (const tag of analysis.tags.filter(t => t.parent === scopeTag || (!scopeTag && !t.parent))) visit(tag);
	for (const statement of analysis.statements) {
		if (statement.tag !== (scopeTag || undefined) || !statement.declaration) continue;
		if (scopeBlock ? statement.codeParent !== scopeBlock : statement.codeParent && !XOJO_OBJECT_TYPES[statement.codeParent.type]) continue;
		const declaration = statement.declaration;
		if (declaration.kind === "object") {
			if (scopeBlock && statement.block !== scopeBlock) addGrouped(parent, declaration.objectType === "enum" ? "Enums" : "Types",
				objectSymbol(analysis, statement.block, declaration.objectType, declaration), objectType);
		} else addDeclaration(parent, statement, statement.block || statement, objectType);
	}
}

function layoutOutline(analysis, isMenu) {
	const layout = analysis.blocks.filter(b => b.type === "begin");
	const rootBlock = layout.find(b => isMenu ? /^(Menu|DesktopMenuBar)$/i.test(b.uiType) : /^(DesktopWindow|Window)$/i.test(b.uiType)) || layout[0];
	if (!rootBlock) return [];
	const root = model(rootBlock.name, rootBlock.uiType, isMenu ? "Namespace" : "Class",
		{ start: 0, end: analysis.text.length }, { nameStart: rootBlock.nameStart, nameEnd: rootBlock.nameStart + rootBlock.name.length });
	const controls = layout.filter(b => b !== rootBlock && b.start >= rootBlock.start && b.end <= rootBlock.end).map(block => {
		const attribute = key => {
			const statement = analysis.statements.find(s => s.codeParent === block && new RegExp(`^\\s*${key}\\s*=`, "i").test(s.code));
			return statement && new RegExp(`^\\s*${key}\\s*=\\s*"((?:""|[^"])*)"`, "i").exec(statement.content)?.[1]?.replace(/""/g, '"');
		};
		const text = attribute("Text");
		const symbol = model(block.name, isMenu ? text === "-" ? "Separator" : text || block.uiType : block.uiType,
			isMenu && text === "-" ? "Null" : isMenu && /^(Menu|DesktopMenuBar)$/i.test(block.uiType) ? "Namespace" : /QuitMenuItem$/i.test(block.uiType) ? "Event" : "Field", block,
			{ nameStart: block.nameStart, nameEnd: block.nameStart + block.name.length });
		return { name: block.name, parentName: attribute("InitialParent"), block, symbol };
	});
	for (const control of controls) {
		control.parent = isMenu || !control.parentName ? controls.find(c => c.block === control.block.parent) :
			controls.find(c => c !== control && c.name.toLowerCase() === control.parentName.toLowerCase());
	}
	const hasCycle = control => {
		const visited = new Set([control]);
		for (let parent = control.parent; parent; parent = parent.parent) {
			if (visited.has(parent)) return true;
			visited.add(parent);
		}
		return false;
	};
	const cyclic = controls.filter(hasCycle);
	for (const control of cyclic) control.parent = undefined;
	for (const control of controls) {
		if (control.parent) control.parent.symbol.children.push(control.symbol);
		else if (isMenu) root.children.push(control.symbol);
		else addGrouped(root, "Controls", control.symbol);
	}
	// Preserve the previous closest-scope preference for repeated control names.
	const depth = control => control.parent ? depth(control.parent) + 1 : 0;
	controls.sort((a, b) => depth(a) - depth(b));
	if (!isMenu) parseCommonTagBlocks(analysis, root, null, null, controls);
	return [root];
}

/** Infer the parser from the source and path, including untitled object documents. */
function getXojoDocumentKind(analysis, filePath = "") {
	if (/\.xojo_menu$/i.test(filePath) || analysis.blocks.some(block => block.type === "begin" && /^(Menu|DesktopMenuBar)$/i.test(block.uiType))) return "menu";
	if (/\.xojo_window$/i.test(filePath) || analysis.blocks.some(block => block.type === "begin" && /^(DesktopWindow|Window)$/i.test(block.uiType))) return "window";
	if (analysis.tags.some(tag => !tag.parent && XOJO_OBJECT_TYPES[tag.type]) ||
		analysis.statements.some(statement => !statement.tag && !statement.codeParent && statement.declaration?.kind === "object")) return "object";
	return "generic";
}

/** Build plain symbol models, leaving VS Code conversion to the extension. */
function buildXojoOutline(analysis, kind = "generic") {
	let result;
	if (kind === "window" || kind === "menu") result = layoutOutline(analysis, kind === "menu");
	else if (kind === "object") {
		const roots = analysis.tags.filter(t => XOJO_OBJECT_TYPES[t.type] && !t.parent);
		result = roots.map(tag => objectSymbol(analysis, tag, tag.type,
			analysis.statements.find(s => s.tag === tag && s.declaration?.kind === "object")?.declaration));
		if (!result.length) result = analysis.statements.filter(s => s.declaration?.kind === "object" && !s.tag && !s.codeParent)
			.map(s => objectSymbol(analysis, s.block, s.declaration.objectType, s.declaration));
	} else {
		result = analysis.statements.filter(s => s.declaration && !s.tag && !s.codeParent &&
			!["object", "property", "constant"].includes(s.declaration.kind))
			.map(s => routineSymbol(s.declaration, s.block || s));
	}
	const containChildren = symbol => {
		for (const child of symbol.children) {
			containChildren(child);
			symbol.start = Math.min(symbol.start, child.start);
			symbol.end = Math.max(symbol.end, child.end);
		}
	};
	result.forEach(containChildren);
	return result;
}

/** Folding follows physical blocks, never the expanded logical control hierarchy. */
function collectFoldingRanges(analysis) {
	const ranges = new Map();
	for (const block of [...analysis.tags, ...analysis.blocks]) {
		const end = block.endLine - (block.closed ? 1 : 0);
		if (end <= block.startLine) continue;
		const previous = ranges.get(block.startLine);
		if (!previous || end > previous.end) ranges.set(block.startLine, { start: block.startLine, end });
	}
	return [...ranges.values()].sort((a, b) => a.start - b.start);
}

/** Find actual RGB/RGBA literals, excluding comments, strings and project metadata. */
function collectColorLiterals(analysis) {
	const colors = [];
	const literal = /(?<![A-Za-z0-9_\u0080-\uFFFF])&c[ \t]*[0-9a-f]{2}(?:[ \t]*[0-9a-f]{2}){2,3}(?![A-Za-z0-9_\u0080-\uFFFF])/gi;
	for (const statement of analysis.statements) {
		if (/^\s*#tag\b/i.test(statement.code)) continue;
		let isOpaque = false;
		for (let tag = statement.tag; tag; tag = tag.parent) {
			if (OPAQUE_TAGS.has(tag.type)) { isOpaque = true; break; }
		}
		if (isOpaque) continue;
		literal.lastIndex = 0;
		let match;
		while ((match = literal.exec(statement.code))) {
			const start = statement.start + match.index;
			const end = start + match[0].length;
			// Masked strings and continuation markers must not join separate source tokens.
			if (analysis.text.slice(start, end) !== match[0]) continue;
			const hex = match[0].slice(2).replace(/[ \t]/g, "");
			const bytes = hex.match(/../g).map(byte => parseInt(byte, 16));
			colors.push({ start, end, red: bytes[0] / 255, green: bytes[1] / 255,
				blue: bytes[2] / 255, alpha: 1 - (bytes[3] || 0) / 255 });
		}
	}
	return colors;
}

/** Convert normalized editor RGBA to Xojo's inverted alpha while preserving source style. */
function formatColorLiteral(color, original) {
	const parts = /^(&[cC])([ \t]*)([0-9a-f]{2})([ \t]*)([0-9a-f]{2})([ \t]*)([0-9a-f]{2})(?:([ \t]*)([0-9a-f]{2}))?$/i.exec(original);
	if (!parts) return null;
	const toByte = value => Math.round(Math.max(0, Math.min(1, value)) * 255);
	const transparency = toByte(1 - color.alpha);
	const originalHex = parts[3] + parts[5] + parts[7] + (parts[9] || "");
	const useLowerCase = /[a-f]/.test(originalHex) && !/[A-F]/.test(originalHex);
	const hexByte = byte => {
		const hex = byte.toString(16).padStart(2, "0");
		return useLowerCase ? hex : hex.toUpperCase();
	};
	let result = parts[1] + parts[2] + hexByte(toByte(color.red)) + parts[4] +
		hexByte(toByte(color.green)) + parts[6] + hexByte(toByte(color.blue));
	if (parts[9] || transparency !== 0) result += (parts[8] ?? parts[6]) + hexByte(transparency);
	return result;
}

module.exports = {
	scanXojoSource, parseDeclaration, getXojoDocumentKind, buildXojoOutline, collectFoldingRanges,
	collectColorLiterals, formatColorLiteral, XOJO_OBJECT_TYPES,
};
