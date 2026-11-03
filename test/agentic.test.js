const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { RUN_FILE, ERROR_FILE, agenticEnabled, runMode, XojoAgenticRunner } = require("../src/xojoAgentic");

async function fixture(t) {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "xojo-agentic-")));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	return { directory, project: path.join(directory, "App.xojo_project"),
		marker: path.join(directory, RUN_FILE), errors: path.join(directory, ERROR_FILE) };
}

async function waitFor(file) {
	const deadline = Date.now() + 2000;
	while (true) {
		try { await fs.stat(file); return; }
		catch (error) { if (error.code !== "ENOENT" || Date.now() > deadline) throw error; }
		await new Promise(resolve => setTimeout(resolve, 2));
	}
}

const fast = { timeoutMs: 2000, errorWaitMs: 25, pollMs: 2 };

test("auto routing reads the actual manifest field, not guidance text", () => {
	assert.equal(agenticEnabled("Type=Desktop\r\nAgenticMode=True\r\n"), true);
	for (const text of ["AgenticMode=False", "Name=AgenticMode=True", "AgenticMode=TrueMore", "XOJO-CODING.md", "Note=AgenticMode=True"]) {
		assert.equal(agenticEnabled(text), false);
		assert.equal(runMode("auto", text), "legacy");
	}
	assert.equal(runMode("auto", "AgenticMode=True"), "agentic");
	assert.equal(runMode("legacy", "AgenticMode=True"), "legacy");
	assert.equal(runMode("agentic", ""), "agentic");
	assert.throws(() => runMode("invalid", ""), /Unknown/);
});

test("creates an empty marker beside the manifest and observes consumption without claiming success", async t => {
	const f = await fixture(t), runner = new XojoAgenticRunner(), statuses = [];
	const pending = runner.run(f.project, { ...fast, onStatus: status => statuses.push(status) });
	await waitFor(f.marker);
	assert.equal(await fs.readFile(f.marker, "utf8"), "");
	await fs.unlink(f.marker);
	const result = await pending;
	assert.equal(result.status, "observed");
	assert.equal(result.consumed, true);
	assert.equal(result.errors, null);
	assert.deepEqual(statuses, ["pending", "consumed"]);
});

test("returns fresh raw errors, including when an old file is rewritten with identical text", async t => {
	for (const old of [null, "Compile error"]) {
		const f = await fixture(t), runner = new XojoAgenticRunner();
		if (old) await fs.writeFile(f.errors, old);
		const pending = runner.run(f.project, { ...fast, errorWaitMs: 50 });
		await waitFor(f.marker);
		await fs.unlink(f.marker);
		await fs.writeFile(f.errors, "Compile error");
		// Some file systems have coarse timestamp resolution; make freshness explicit.
		await fs.utimes(f.errors, new Date(), new Date(Date.now() + 2000));
		const result = await pending;
		assert.equal(result.errors, "Compile error");
		assert.equal(result.errorsFile, f.errors);
		assert.equal(await fs.readFile(f.errors, "utf8"), "Compile error");
	}
});

test("preserves untouched old errors and does not report them as new", async t => {
	const f = await fixture(t), runner = new XojoAgenticRunner();
	await fs.writeFile(f.errors, "Old error");
	const pending = runner.run(f.project, fast);
	await waitFor(f.marker); await fs.unlink(f.marker);
	const result = await pending;
	assert.equal(result.staleErrors, true);
	assert.equal(result.errors, null);
	assert.equal(await fs.readFile(f.errors, "utf8"), "Old error");
});

test("does not overwrite an existing marker or issue overlapping runs in the same directory", async t => {
	const f = await fixture(t), runner = new XojoAgenticRunner();
	await fs.writeFile(f.marker, "Other request");
	await assert.rejects(runner.run(f.project, fast), /既に存在/);
	assert.equal(await fs.readFile(f.marker, "utf8"), "Other request");
	await fs.unlink(f.marker);
	const pending = runner.run(f.project, fast);
	await waitFor(f.marker);
	await assert.rejects(runner.run(path.join(f.directory, "Other.xojo_project"), fast), /処理中/);
	await fs.unlink(f.marker); await pending;
	// The directory lock is released after a completed request.
	const next = runner.run(f.project, fast);
	await waitFor(f.marker); await fs.unlink(f.marker);
	assert.equal((await next).status, "observed");
});

test("timeout removes only its own unconsumed marker", async t => {
	const f = await fixture(t), runner = new XojoAgenticRunner();
	const result = await runner.run(f.project, { ...fast, timeoutMs: 15 });
	assert.equal(result.status, "timeout");
	await assert.rejects(fs.stat(f.marker), { code: "ENOENT" });
});

test("cancellation before request, while pending and after consumption cleans up appropriately", async t => {
	const f = await fixture(t), runner = new XojoAgenticRunner(), token = { isCancellationRequested: true };
	assert.equal((await runner.run(f.project, { ...fast, token })).status, "cancelled");
	await assert.rejects(fs.stat(f.marker), { code: "ENOENT" });
	token.isCancellationRequested = false;
	let pending = runner.run(f.project, { ...fast, token });
	await waitFor(f.marker); token.isCancellationRequested = true;
	assert.equal((await pending).consumed, false);
	await assert.rejects(fs.stat(f.marker), { code: "ENOENT" });
	token.isCancellationRequested = false;
	pending = runner.run(f.project, { ...fast, token, onStatus: status => {
		if (status === "consumed") token.isCancellationRequested = true;
	} });
	await waitFor(f.marker); await fs.unlink(f.marker);
	assert.equal((await pending).consumed, true);
});

test("disposal cancels pending waits and prevents new requests", async t => {
	const f = await fixture(t), runner = new XojoAgenticRunner();
	const pending = runner.run(f.project, fast);
	await waitFor(f.marker); runner.dispose();
	assert.equal((await pending).status, "cancelled");
	await assert.rejects(fs.stat(f.marker), { code: "ENOENT" });
	await assert.rejects(runner.run(f.project, fast), /disposed/);
});

test("replacement marker is preserved when ownership changes", async t => {
	const f = await fixture(t), runner = new XojoAgenticRunner();
	const pending = runner.run(f.project, fast);
	await waitFor(f.marker);
	await fs.writeFile(f.marker + ".new", "Replacement");
	await fs.rename(f.marker + ".new", f.marker);
	await assert.rejects(pending, /置き換/);
	assert.equal(await fs.readFile(f.marker, "utf8"), "Replacement");
});
