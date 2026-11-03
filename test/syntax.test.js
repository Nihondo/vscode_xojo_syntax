const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { scanXojoSource, buildXojoOutline, collectFoldingRanges } = require("../src/xojoSyntax");

const fixture = name => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const outline = (text, kind = "object") => buildXojoOutline(scanXojoSource(text), kind);
const flatten = symbols => symbols.flatMap(s => [s, ...flatten(s.children)]);
const find = (symbols, name) => flatten(symbols).find(s => s.name === name);

test("tagged members preserve signatures and ignore bodies, notes and metadata", () => {
	const text = fixture("Members.xojo_code");
	const symbols = outline(text);
	assert.equal(symbols[0].name, "Example");
	const create = find(symbols, "Create");
	assert.match(create.detail, /^Private Shared \(values\(\) As String,/);
	assert.match(create.detail, /Optional label As String = "\(a,b\)""quoted"""/);
	assert.match(create.detail, /As MyModule.Result\(\)$/);
	assert.equal(text.slice(create.selectionStart, create.selectionEnd), "Create");
	for (const name of ["LocalOnly", "LocalNative", "Fake", "FakeProperty"]) assert.equal(find(symbols, name), undefined);
	assert.deepEqual(find(symbols, "Count").children.map(s => s.name), ["Get", "Set"]);
	assert.equal(find(symbols, "Names").detail, "() As String");
	assert.deepEqual(find(symbols, "Events").children.map(s => s.name), ["Updated"]);
	assert.deepEqual(find(symbols, "Delegates").children.map(s => s.name), ["Callback"]);
	assert.match(find(symbols, "Native").detail, /Soft Declare/);
	assert.equal(find(symbols, "Native").kind, "Function");
	assert.deepEqual(find(symbols, "LogLevel").children.map(s => [s.name, s.kind]), [["Debug", "EnumMember"], ["Warning", "EnumMember"]]);
	assert.equal(text.slice(find(symbols, "LogLevel").selectionStart, find(symbols, "LogLevel").selectionEnd), "LogLevel");
	assert.equal(find(symbols, "Person").kind, "Struct");
	assert.ok(find(symbols, "Age"));
	assert.equal(find(symbols, "Greeting").detail, "As String");
	assert.deepEqual(find(symbols, "MenuHandlers").children.map(s => s.name), ["HandleMenu"]);
});

test("free declarations, Unicode identifiers and original CRLF offsets", () => {
	const text = 'Shared Function C結果(values() As String, _\r\n  label As String = "()") As MyModule.Result()\r\nEnd Function\r\nDelegate Sub Callback(value As Integer)\r\nSoft Declare Function Native Lib "test" As CString';
	const symbols = outline(text, "generic");
	assert.deepEqual(symbols.map(s => s.name), ["C結果", "Callback", "Native"]);
	assert.match(symbols[0].detail, /As MyModule.Result\(\)$/);
	assert.equal(text.slice(symbols[0].selectionStart, symbols[0].selectionEnd), "C結果");
	assert.equal(symbols[0].end, text.indexOf("End Function") + "End Function".length);
	assert.equal(symbols[2].end, text.length);
});

test("free object members are scoped and nested enums have values", () => {
	const text = 'Module Demo\nGlobal Count As Integer\nShared Function Run() As Integer\nConst Local = 1\nEnd Function\nEnum Level\nOne\nTwo = 2\nEnd Enum\nEnd Module';
	const symbols = outline(text);
	assert.ok(find(symbols, "Count"));
	assert.ok(find(symbols, "Run"));
	assert.equal(find(symbols, "Local"), undefined);
	assert.deepEqual(find(symbols, "Level").children.map(s => s.name), ["One", "Two"]);
});

test("window hierarchy uses case-insensitive parents, contains event ranges and breaks cycles", () => {
	const text = fixture("Layout.xojo_window");
	const symbols = outline(text, "window");
	assert.ok(find(symbols, "Panel").children.some(s => s.name === "Button"));
	assert.equal(find(symbols, "Button").children[0].name, "Pressed");
	for (const name of ["Lost", "CycleA", "CycleB"]) assert.ok(find(symbols, "Controls").children.some(s => s.name === name));
	assert.equal(find(symbols, "Event Handlers").children[0].name, "Opening");
	const check = symbol => {
		assert.ok(symbol.selectionStart >= symbol.start && symbol.selectionEnd <= symbol.end, symbol.name);
		for (const child of symbol.children) {
			assert.ok(child.start >= symbol.start && child.end <= symbol.end, child.name);
			check(child);
		}
	};
	symbols.forEach(check);
	const analysis = scanXojoSource(text);
	const buttonBlock = analysis.blocks.find(b => b.name === "Button");
	assert.ok(find(symbols, "Button").end > buttonBlock.end);
	assert.equal(collectFoldingRanges(analysis).find(r => r.start === buttonBlock.startLine).end, buttonBlock.endLine - 1);
});

test("menu hierarchy retains text, escaped quotes and separators", () => {
	const text = '#tag Menu\nBegin Menu Main\nBegin DesktopMenuItem File\nText = "File ""Menu"""\nBegin DesktopMenuItem Separator\nText = "-"\nEnd\nEnd\nEnd\n#tag EndMenu';
	const symbols = outline(text, "menu");
	assert.equal(find(symbols, "File").detail, 'File "Menu"');
	assert.equal(find(symbols, "Separator").kind, "Null");
	assert.equal(find(symbols, "File").children[0].name, "Separator");
});

test("folding covers physical control blocks and leaves terminators visible", () => {
	const lines = ['Sub Run()', '#If TargetMacOS Then', 'If flag Then', 'For Each item As String In items', 'While ready', 'Do', 'Try', 'Select Case item', 'Case Else', 'Return', 'End Select', 'Catch error As RuntimeException', 'End Try', 'Loop Until done', 'Wend', 'Next', 'Else', 'Return', 'End If', '#Else', 'Return', '#EndIf', 'End Sub'];
	const ranges = collectFoldingRanges(scanXojoSource(lines.join('\n')));
	assert.deepEqual(ranges, [{start:0,end:21},{start:1,end:20},{start:2,end:17},{start:3,end:14},{start:4,end:13},{start:5,end:12},{start:6,end:11},{start:7,end:9}]);
});

test("single-line conditions, quotes, comments and If expressions do not open blocks", () => {
	const text = ['Sub Run()', 'If flag Then Return', '#If TargetMacOS Then Return', 'Var result As Integer = If(flag, 1, 2)', 'Var s As String = "#If x Then // End Sub"', 'Var slash As String = "\\"', "' If ignored Then", '// End Sub', 'Rem #If ignored Then', 'Return', 'End Sub'].join('\n');
	const analysis = scanXojoSource(text);
	assert.deepEqual(analysis.blocks.map(b => b.type), ['sub']);
	assert.deepEqual(collectFoldingRanges(analysis), [{start:0,end:9}]);
});

test("incomplete blocks end at their containing region and empty sources are safe", () => {
	const text = '#tag Class\nClass Demo\n#tag Method\nSub Unfinished()\nIf flag Then\nReturn\n#tag EndClass';
	const analysis = scanXojoSource(text);
	assert.equal(find(buildXojoOutline(analysis, 'object'), 'Unfinished').end, text.indexOf('\n#tag EndClass'));
	assert.ok(collectFoldingRanges(analysis).every(r => r.end <= 5));
	assert.deepEqual(outline(''), []);
	assert.deepEqual(collectFoldingRanges(scanXojoSource('')), []);
});

test("interface signatures do not consume subsequent members", () => {
	const symbols = outline('#tag Interface\nInterface Demo\n#tag Method\nSub First(values() As String)\n#tag EndMethod\n#tag Method\nFunction Second() As String\n#tag EndMethod\nEnd Interface\n#tag EndInterface');
	assert.deepEqual(find(symbols, 'Methods').children.map(s => s.name), ['First', 'Second']);
});

test("an unfinished tagged member does not hide its next sibling", () => {
	const text = '#tag Class\nClass Demo\n#tag Method\nSub Incomplete()\nIf ready Then\nReturn\n#tag Property\nName As String\n#tag EndProperty\n#tag Method\nSub Complete()\nEnd Sub\n#tag EndMethod\nEnd Class\n#tag EndClass';
	const symbols = outline(text);
	assert.ok(find(symbols, 'Incomplete'));
	assert.ok(find(symbols, 'Name'));
	assert.ok(find(symbols, 'Complete'));
	assert.equal(find(symbols, 'Incomplete').end, text.indexOf('\n#tag Property'));
});
