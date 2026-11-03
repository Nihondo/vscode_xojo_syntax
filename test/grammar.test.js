const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Registry, parseRawGrammar, INITIAL } = require("vscode-textmate");
const oniguruma = require("vscode-oniguruma");

const grammarPromise = (async () => {
	const wasm = fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
	await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
	const registry = new Registry({
		onigLib: Promise.resolve({ createOnigScanner: patterns => new oniguruma.OnigScanner(patterns), createOnigString: text => new oniguruma.OnigString(text) }),
		loadGrammar: async () => parseRawGrammar(fs.readFileSync(path.join(__dirname, "../syntaxes/xojo.tmLanguage.json"), "utf8"), "xojo.json"),
	});
	return registry.loadGrammar("source.xojo");
})();

async function tokenize(lines) {
	const grammar = await grammarPromise;
	let state = INITIAL;
	return lines.map(line => {
		const result = grammar.tokenizeLine(line, state);
		state = result.ruleStack;
		return result.tokens.map(t => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes }));
	});
}

const has = (tokens, text, scope) => tokens.some(t => t.text === text && t.scopes.includes(scope));
const scopeAt = (tokens, text) => tokens.filter(t => t.text.includes(text)).flatMap(t => t.scopes);

test("compiler directives remain highlighted while complete tag headers are subdued", async () => {
	const [directive, pragma, tag, comment] = await tokenize(['#If TargetMacOS Then', '#Pragma BoundsChecking False', '#tag Enum, Name = Level, Flags = &h0', "' #If ignored"]);
	assert.ok(has(directive, '#If', 'keyword.control.directive.xojo'));
	assert.ok(has(directive, 'TargetMacOS', 'support.constant.target.xojo'));
	assert.ok(has(pragma, '#Pragma', 'keyword.control.directive.xojo'));
	assert.ok(has(tag, '#tag Enum, Name = Level, Flags = &h0', 'comment.line.metadata.xojo'));
	assert.ok(scopeAt(comment, '#If').includes('comment.line.apostrophe.xojo'));
	const headers = await tokenize(['#tag Class', '#tag Method, Flags = &h0', '#tag EndMethod', '#tag Constant, Name = Greeting, Default = "hello"', '#tag Note', '#tag EndNote', '#tag EndClass']);
	for (const tokens of headers) {
		assert.ok(tokens.every(token => token.scopes.some(scope => scope.startsWith('comment.'))));
		assert.ok(tokens.every(token => !token.scopes.some(scope => /^(keyword|entity|constant|string)\./.test(scope))));
	}
});

test("doubled quotes escape quotes and a backslash does not escape the terminator", async () => {
	const [quoted, slash, next] = await tokenize(['Var s As String = "He ""said"" // #If"', 'Var slash As String = "\\"', 'Return True']);
	assert.ok(has(quoted, '""', 'constant.character.escape.xojo'));
	assert.ok(scopeAt(quoted, '// #If').includes('string.quoted.double.xojo'));
	assert.ok(slash.some(t => t.text === '"' && t.scopes.includes('string.quoted.double.xojo')));
	assert.ok(has(next, 'Return', 'keyword.control.xojo'));
	assert.ok(next.every(t => !t.scopes.includes('string.quoted.double.xojo')));
});

test("radix, spaced color, Unicode and exponent literals tokenize completely", async () => {
	const cases = [['&hFF', 'constant.numeric.hex.xojo'], ['&B101', 'constant.numeric.binary.xojo'], ['&o755', 'constant.numeric.octal.xojo'], ['&cFF0000', 'constant.other.color.xojo'], ['&c FF 00 00 7F', 'constant.other.color.xojo'], ['&u1F600', 'constant.character.unicode.xojo'], ['1E10', 'constant.numeric.float.xojo'], ['6.022e23', 'constant.numeric.float.xojo'], ['.5', 'constant.numeric.float.xojo']];
	for (const [literal, scope] of cases) {
		const [tokens] = await tokenize(['Var value As Variant = ' + literal]);
		assert.ok(has(tokens, literal, scope), literal);
	}
});

test("declarations take precedence and nested array parentheses stay inside parameters", async () => {
	const [first, second] = await tokenize(['Private Shared Function C結果(values() As String, _', 'Optional label As String = "()") As MyModule.Result']);
	assert.ok(has(first, 'C結果', 'entity.name.function.xojo'));
	assert.ok(has(first, 'values', 'variable.parameter.xojo'));
	assert.ok(has(first, 'String', 'support.type.xojo'));
	assert.ok(has(second, 'Optional', 'storage.modifier.xojo'));
	assert.ok(has(second, 'label', 'variable.parameter.xojo'));
	const [delegate] = await tokenize(['Delegate Sub Callback(value As Integer)']);
	assert.ok(has(delegate, 'Callback', 'entity.name.function.xojo'));
});

test("legacy comments and keywords remain supported without matching identifier prefixes", async () => {
	const [rem, dim, expressions, unicode] = await tokenize(['Rem legacy comment', 'Dim value As Integer', 'Do Until ready And value Mod 2 = 0', 'If値 = True']);
	assert.ok(scopeAt(rem, 'Rem').includes('comment.line.rem.xojo'));
	assert.ok(has(dim, 'Dim', 'storage.type.modifier.xojo'));
	assert.ok(has(expressions, 'Until', 'keyword.control.xojo'));
	assert.ok(has(expressions, 'And', 'keyword.operator.word.xojo'));
	assert.ok(has(expressions, 'Mod', 'keyword.operator.word.xojo'));
	assert.ok(!unicode.some(t => t.text === 'If'));
});

test("serialized metadata strings and notes are isolated from code strings", async () => {
	const lines = await tokenize(['Begin DesktopWindow Demo', 'Title = "line\\x0Atext"', 'End', '#tag Note', 'Sub Fake()', '#tag EndNote', 'Sub Real()']);
	assert.ok(has(lines[1], '\\x0A', 'constant.character.escape.metadata.xojo'));
	assert.ok(scopeAt(lines[4], 'Sub Fake').includes('comment.block.documentation.xojo'));
	assert.ok(has(lines[6], 'Real', 'entity.name.function.xojo'));
});
