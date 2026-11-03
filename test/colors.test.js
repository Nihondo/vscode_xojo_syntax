const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { scanXojoSource, collectColorLiterals, formatColorLiteral } = require("../src/xojoSyntax");

const colors = text => collectColorLiterals(scanXojoSource(text));

test("RGB and RGBA colors use normalized channels with inverted Xojo transparency", () => {
	const text = fs.readFileSync(path.join(__dirname, 'fixtures/Colors.xojo_script'), 'utf8');
	const found = colors(text);
	assert.equal(found.length, 5);
	assert.deepEqual(found.map(c => text.slice(c.start, c.end)), ['&cFF0000', '&C00FF00', '&c FF 00 00 7F', '&c0000FFFF', '&cabcdef']);
	assert.deepEqual([found[0].red, found[0].green, found[0].blue, found[0].alpha], [1, 0, 0, 1]);
	assert.equal(found[2].alpha, 1 - 127 / 255);
	assert.equal(found[3].alpha, 0);
	assert.equal(found[4].red, 171 / 255);
});

test("comments, strings, tag headers and metadata bodies do not produce decorations", () => {
	const text = ['Var text As String = """&cFF0000"""', "' &cFF0000", '// &cFF0000', 'Rem &cFF0000', '#tag Constant, Name = Color, Default = &cFF0000', '#tag EndConstant', '#tag Note', 'Example = &cFF0000', '#tag EndNote', '#tag ViewBehavior', 'InitialValue = &cFF0000', '#tag EndViewBehavior', 'Begin DesktopWindow Demo', 'BackgroundColor = &c112233', 'End'].join('\n');
	assert.deepEqual(colors(text).map(c => text.slice(c.start, c.end)), ['&c112233']);
});

test("color ranges preserve Unicode and CRLF source offsets", () => {
	const text = 'Var A色 As String = "😀"\r\nVar B色 As Color = &c\t12 34\t56\r\nVar C色 As Color = &CABCDEF00';
	const found = colors(text);
	assert.equal(found.length, 2);
	assert.equal(found[0].start, text.indexOf('&c'));
	assert.equal(text.slice(found[0].start, found[0].end), '&c\t12 34\t56');
	assert.equal(text.slice(found[1].start, found[1].end), '&CABCDEF00');
});

test("incomplete and embedded color-like text is not accepted", () => {
	for (const literal of ['&c', '&cFFF', '&c12345', '&c1234567', '&c123456789', '&cFF00GG', '&cFF0000suffix', 'Prefix&cFF0000', '&cFF0000色', '&cFF "00" 00', '&cFF _\n00 00']) assert.deepEqual(colors(literal), [], literal);
});

test("picker replacements retain prefix, spacing, letter case and explicit alpha", () => {
	const green = { red: 0, green: 1, blue: 0, alpha: 1 };
	assert.equal(formatColorLiteral(green, '&cFF0000'), '&c00FF00');
	assert.equal(formatColorLiteral(green, '&Cff0000'), '&C00ff00');
	assert.equal(formatColorLiteral(green, '&c FF\t00 00'), '&c 00\tFF 00');
	assert.equal(formatColorLiteral(green, '&cFF000000'), '&c00FF0000');
	const half = { ...green, alpha: 0.5 };
	assert.equal(formatColorLiteral(half, '&c FF 00 00'), '&c 00 FF 00 80');
	assert.equal(formatColorLiteral(half, '&cFF0000'), '&c00FF0080');
	assert.equal(formatColorLiteral({ ...green, alpha: 0 }, '&cFF0000'), '&c00FF00FF');
	assert.equal(formatColorLiteral(green, 'not a color'), null);
});

test("all 256 transparency values survive a preview/picker byte round trip", () => {
	for (let alpha = 0; alpha <= 255; alpha++) {
		const literal = '&c123456' + alpha.toString(16).padStart(2, '0').toUpperCase();
		assert.equal(formatColorLiteral(colors(literal)[0], literal), literal);
	}
});
