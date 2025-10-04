# Changelog

## 0.9.0
- `.xojo_menu` ファイルのメニュー階層をアウトライン表示に対応
- `parseXojoMenuSymbols` を実装し、`Begin Menu` → `Begin DesktopMenuItem` のネスト構造を解析
- メニュー項目タイプ（DesktopMenuItem, DesktopQuitMenuItem, DesktopApplicationMenuItem等）ごとにSymbolKindを割り当て
- `Text` 属性を読み取りメニュー項目の詳細情報として表示
- セパレーター（`Text = "-"`）を `SymbolKind.Null` で表現
- MainMenuBar.xojo_menu サンプルでメニュー階層表示を検証

## 0.8.0
- `#tag Events` ブロックの多階層対応を実装し、ネストされたコントロールのイベントを正しく親子付け
- `parseCommonTagBlocks` を拡張し、階層配列形式の `controlsByName` をサポート
- コントロールパス（親チェーン）を自動構築し、同名コントロールでも最も近いスコープを優先
- `parseXojoWindowSymbols` でコントロール情報を `{name, path, symbol}` 形式で管理
- settingWindow.xojo_window の `#tag Events` ブロックで階層対応を検証

## 0.7.0
- `.xojo_window` のコントロール階層検出を強化し、`InitialParent` 属性に基づく親子関係を正しく表示
- DesktopTabPanel 等のコンテナコントロール配下に子コントロールが階層化されるように改善
- settingWindow.xojo_window サンプルを追加し、階層的なコントロール構造のテスト環境を整備

## 0.6.0
- `.xojo_code` のアウトライン機能を拡張し、Class 以外のトップレベルオブジェクト（Module/Interface/Structure/Enum）に対応
- `parseXojoObjectSymbols` 関数でオブジェクト種別ごとに適切なグループ構造を自動適用
- サンプルファイルを追加（SampleModule.xojo_code, SampleInterface.xojo_code, SampleStructure.xojo_code, SampleEnum.xojo_code）

## 0.5.0
- Xojo Reload and Run 機能追加（macOS のみ）
- デバッグプロバイダーでF5キーによる実行対応

## 0.1.0
- 初版: 最小のハイライト（コメント/文字列/数値/キーワード/型）