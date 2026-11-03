# Developer Guide

This repository contains the Xojo Syntax Support extension for VS Code. It provides syntax highlighting, hierarchical Outline, workspace symbol search, structural folding, color previews/picker, editing configuration, snippets, a read-only library API viewer, Agentic Mode run requests, and legacy macOS Reload and Run integration.

## Commands

- Install development dependencies: `npm ci` (Node.js 22+ is required by the packaging tools; the extension itself retains VS Code ^1.70.0 compatibility).
- Run regression tests: `npm test`.
- Check the entry point: `node --check extension.js`.
- Package: `npx @vscode/vsce package`.
- Debug in VS Code: F5, using `.vscode/launch.json`'s **Launch Extension** configuration.

## Runtime structure

- `extension.js`: extension activation, provider registration, VS Code symbol conversion, the read-only `xojo-library` content provider and ZIP reader, library selection commands, and legacy macOS IDE automation. Command and F5 execution share XojoRunController; existing delay options are retained. `getXojoAnalysis` caches source analysis by document identity/version. Outline, folding and color providers use the same file/untitled/xojo-library selectors.
- `src/xojoRun.js`: XojoRunController resolves local manifests across workspace roots, prefers the active file's nearest enclosing project, prompts for ambiguity, and honors launch projectPath. Auto mode reads AgenticMode=True; xojo.run.mode and launch runMode can select agentic/legacy explicitly. Agentic requests use cancellable notification progress and raw Output > Xojo messages. Only macOS has application-opening support; other platforms require Xojo to be open already.
- `src/xojoAgentic.js`: Node-only file protocol. Exclusively create XojoRunProject.txt beside the manifest and lock by canonical directory (even when two manifests share it). Observe marker consumption with a 30-second default timeout, then observe XojoCompileErrors.txt for ten seconds. Compare pre-request file metadata/content to avoid attributing unchanged old errors to a new run. Never delete compile errors, overwrite an existing request, retry via legacy automation after a timeout, or declare build success from a quiet window. Timeout/cancellation/disposal cleans up an owned pending marker; consumed requests cannot be stopped through this protocol. The snapshot comparison is a freshness heuristic, not a documented Xojo request-ID protocol.
- `src/xojoSyntax.js`: pure CommonJS source analysis. `getXojoDocumentKind` is shared by Outline and workspace search. `scanXojoSource` builds logical statements, nested tags, and physical code blocks. `parseDeclaration` recognizes modifiers, Declare/Delegate declarations, arrays, qualified types and continued signatures. `buildXojoOutline` constructs plain symbol models; `parseCommonTagBlocks` extracts semantic members. `collectFoldingRanges` operates only on physical blocks. `collectColorLiterals` reuses lexical masks and tag context; `formatColorLiteral` converts normalized RGBA back to the original Xojo literal style.
- `src/xojoWorkspaceSymbols.js`: lazy workspace index. `collectWorkspaceSymbols` flattens real Outline models and skips isGroup nodes. `XojoWorkspaceIndex` discovers source files through workspace.findFiles, caches disk symbols, overlays open document versions and matches query subsequences. It uses workspace.fs with at most four concurrent reads.
- `syntaxes/xojo.tmLanguage.json`: TextMate/Oniguruma grammar. Declaration rules precede general keywords. Parameter parentheses recurse; Xojo strings escape quotes with doubled quotes. Serialized metadata strings have separate escape rules. Entire #tag headers use comment.line.metadata.xojo without keyword/name captures, including their attributes. Note delimiters inherit the documentation-comment scope. Keep compiler directives such as #If and #Pragma distinct.
- `language-configuration.json`: apostrophe line comments, bracket/quote pairs and declarative block/branch indentation.
- `snippets/xojo.json`: eleven snippets contributed by package.json.

## Parsing invariants

- Source offsets and selections are UTF-16 offsets suitable for `TextDocument.positionAt`; preserve original CRLF/CR/LF source positions.
- Xojo names and control-parent references are case-insensitive. Retain the original spelling. Identifiers start with an ASCII letter (or a permissive legacy underscore) and may contain Unicode afterwards.
- Ignore comments and quoted text when finding structural keywords. A backslash does not escape a quote in Xojo source. `_` continuation may precede a comment; keep original parameter text and source offsets.
- `#tag` is project serialization metadata; `#If` and `#Pragma` are compiler directives. A bare hash is not a comment. Retain legacy Dim/Rem notation.
- Tags form a nested structure. Notes and ViewBehavior are opaque to member extraction. Method-local constants and Declares must not leak into object members. ComputedProperty declarations are outside Getter/Setter tags, often after them.
- Hook declarations belong to Events; Event implementations belong to Event Handlers or their controls; delegates belong to Delegates; Handles routines belong to MenuHandlers. Enum values are EnumMember symbols. `XOJO_OBJECT_TYPES` defines object kinds/groups.
- Outline is a logical hierarchy. InitialParent may attach physically separate controls; their event implementations may occur after layout blocks. Expand parent ranges to contain all children, but keep selection ranges on names. Break parent cycles and retain unresolved controls at the root.
- Folding is a physical hierarchy. Never derive folds from the expanded Outline ranges. Leave terminators visible; omit single-line If/#If and single-line declarations. Recover missing terminators at their containing tag boundary or EOF, and recover an unfinished tagged member before its next sibling.
- Color previews must ignore comments, strings, all #tag headers, Note and ViewBehavior. Preserve UTF-16 ranges. Xojo alpha represents transparency (00 opaque, FF transparent), so invert it when converting to/from VS Code opacity. Keep existing component spacing, prefix/letter case and explicit alpha width when writing; append alpha to RGB only if needed. Library virtual documents get previews but no color-presentation edits.
- Workspace symbol locations use declaration selections, not expanded Outline ranges. Never return synthetic isGroup labels; retain semantic parent names and overloads. Watch folder operations as well as files, rediscover on root/files.exclude changes, and invalidate source reads by record identity/revision. Skip unreadable files without failing other results and retry later. Open document text overrides disk by URI/version. VS Code may retain a saved TextDocument model after its editor is closed: keep deletion tombstones so rename/delete cannot resurrect it, while retaining genuinely unsaved content. Do not scan unopened library archives or Git snapshot documents.
- Do not evaluate target conditions or infer types. This is structural editor support, not a compiler or language server.

## Tests and packaging

`test/syntax.test.js` covers source scanning, Outline and folding. `test/grammar.test.js` uses vscode-textmate/vscode-oniguruma to verify actual token scopes. `test/colors.test.js` covers extraction and style-preserving color conversions, including all 256 alpha bytes. `test/editing.test.js` checks language configuration and snippets. `test/extension.test.js` validates provider registration, VS Code adaptation, version-cache invalidation and command/F5 routing with a lightweight API mock. `test/workspace.test.js` covers caching, discovery, overlays, cancellation and asynchronous invalidation races. `test/agentic.test.js` uses real disposable directories to verify marker ownership, consumption, cancellation/disposal, timeout and fresh/stale error output. `test/run.test.js` covers project selection, mode routing, legacy delay forwarding and output behavior without launching Xojo.

Keep reproducible fixtures under tracked `test/fixtures/`. Do not depend on `samples/`, which is local and ignored. `.vscodeignore` excludes tests and plans, but must include `src/xojoSyntax.js`, grammar, language configuration and snippets. Runtime has no npm dependencies; tooling is development-only.

An actual VS Code integration runner is available at `test/vscode/index.js`. With `code` available on PATH, run it from the repository root using isolated temporary user/extension directories:

```bash
code --user-data-dir /tmp/xojo-qa-user --extensions-dir /tmp/xojo-qa-extensions --extensionDevelopmentPath "$PWD" --extensionTestsPath "$PWD/test/vscode" --disable-extensions --skip-welcome --skip-release-notes
```

This runner uses the built-in color-provider and workspace-symbol commands. It edits unsaved documents to verify refreshed data. For disk/watcher and Agentic checks, pass a disposable folder as the last CLI argument and set `XOJO_TEST_WORKSPACE` to that folder's absolute path. The runner verifies that the folder belongs to the test workspace, creates sources under scratch/, tests creation, unsaved edits, save, rename, external changes and folder deletion, then removes scratch/. Agentic checks use agentic-scratch/ and startDebugging with openProject=false and an explicit test manifest. The test simulates IDE consumption/error output and intentionally starts no debug adapter. It disables saveBeforeStart in the isolated profile so unrelated untitled QA documents remain unsaved. It never launches Xojo and never writes test sources when the environment variable is absent. Choose unused temporary directories so existing profiles remain separate.

## Documentation and scope

README.md is the English user manual; README_ja.md must contain the same instructions and features in Japanese. Keep implementation details here. The investigation, primary sources and verification record are in `plans/xojo-language-support.md`; record completed work in handoff.md using the handoff skill.

The library API viewer remains read-only and does not rewrite archives. Neither the Agentic run path nor the legacy macOS shortcut path is a debugger implementation. Web/Mobile layout expansion, type-aware definition navigation/completion, formatting, rename and structured build diagnostics require separate plans.

Xojo 2026r3 introduces Agentic Mode with automatic reload and the XojoRunProject.txt / XojoCompileErrors.txt file protocol. Treat docs/XOJO-CODING.md as immutable upstream guidance for target Xojo projects. The 2026-11-03 specification review and subsequent implementation record in plans/xojo-language-support.md contain the pinned official reference, measured Attributes/Desktop layout regressions, platform gaps, protocol uncertainties and implementation entry points. Do not assume that the guidance file's presence enables Agentic Mode, or that consuming a run marker confirms compilation success. Keep source property declarations and IDE-serialized Property-tag contents distinct. Do not automatically edit a target manifest to enable the mode.
