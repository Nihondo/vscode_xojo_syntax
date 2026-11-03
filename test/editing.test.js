const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../language-configuration.json");
const snippets = require("../snippets/xojo.json");
const manifest = require("../package.json");
const increase = new RegExp(config.indentationRules.increaseIndentPattern);
const decrease = new RegExp(config.indentationRules.decreaseIndentPattern);

test("indentation recognizes block openers and branches in mixed case", () => {
	for (const line of ['If flag Then', '#If TargetMacOS', '#If TargetMacOS Then', 'ElseIf flag Then', '#ElseIf TargetWindows Then', 'Else', '#Else', 'Private Shared Function Run() As Integer', 'For Each value As String In items', 'While ready', 'Do Until done', 'Select Case value', 'Case Else', 'Try', 'Catch error As RuntimeException', 'Finally', '#tag ComputedProperty', 'Get', 'Set', 'Begin DesktopWindow Demo', '  if x = "Then" Then // comment']) assert.ok(increase.test(line), line);
	for (const line of ['End If', 'End', 'End Function', 'Next', 'Wend', 'Loop Until done', 'ElseIf flag Then', '#Else', '#EndIf', 'Case Else', 'Catch error As RuntimeException', 'Finally', '#tag EndProperty']) assert.ok(decrease.test(line), line);
});

test("single-line conditions, strings and comments do not increase indentation", () => {
	for (const line of ['If flag Then Return', '#If TargetMacOS Then Return', 'If flag Then MessageBox("hello")', 'Var s As String = "If flag Then"', '"If flag Then"', "' If flag Then", '// Sub Fake()', 'Rem If flag Then', '#Pragma BoundsChecking False', '#tag EndProperty', 'If flag Then MessageBox("Then")']) assert.ok(!increase.test(line), line);
	assert.equal(config.comments.lineComment, "'");
	assert.deepEqual(config.autoClosingPairs.find(p => p.open === '"').notIn, ['string', 'comment']);
});

test("eleven snippets are contributed and include a final cursor position", () => {
	assert.equal(Object.keys(snippets).length, 11);
	assert.equal(manifest.contributes.snippets[0].path, './snippets/xojo.json');
	assert.deepEqual(Object.values(snippets).map(s => s.prefix).sort(), ['xojo-if','xojo-select','xojo-for','xojo-foreach','xojo-while','xojo-do','xojo-try','xojo-sub','xojo-function','xojo-const','xojo-ifdef'].sort());
	for (const snippet of Object.values(snippets)) assert.ok(snippet.body.join('\n').includes('$0'), snippet.prefix);
});
