# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

Xojo言語向けのVS Code拡張機能。シンタックスハイライトとアウトライン機能（DocumentSymbolProvider）を提供する。

### 対象ファイル
- `.xojo_code`: Xojoコードオブジェクト（Class/Module/Interface/Structure/Enum）
- `.xojo_script`: Xojoスクリプトファイル
- `.xojo_window`: Xojoウィンドウファイル
- `.xojo_menu`: Xojoメニューファイル

## 開発コマンド

### デバッグ実行
```bash
# VS Codeで拡張機能をデバッグ（F5キー、または以下の設定を使用）
# .vscode/launch.jsonの "Launch Extension" 設定を使用
```

### VSIXパッケージ作成
```bash
npx @vscode/vsce package
```

### VSIXインストール
```bash
# VS Codeコマンドパレット: "Extensions: Install from VSIX..."
# または CLI:
code --install-extension xojo-syntax-<version>.vsix

# 強制再インストール:
code --install-extension xojo-syntax-<version>.vsix --force
```

## アーキテクチャ

### コアコンポーネント

#### 1. extension.js
拡張機能のエントリーポイント。4種類のシンボル抽出を実装:

- **parseGenericFunctionSymbols**: 汎用コードファイル向け
  - Sub/Function/Method/Event/Delegate宣言を検出
  - フラットなシンボルリストを生成

- **parseXojoObjectSymbols**: `.xojo_code`オブジェクトファイル向け
  - Class/Module/Interface/Structure/Enumに対応
  - `#tag`ブロックと自由形式の両方を検出
  - オブジェクト種別ごとに適切なグループ構造を適用
  - 階層構造例: Class → (Methods, Properties, Event Handlers, Constants, MenuHandlers)
  - `XOJO_OBJECT_TYPES`テーブルでオブジェクト定義を管理

- **parseXojoWindowSymbols**: `.xojo_window`ファイル向け
  - `Begin DesktopWindow/Window`〜`End`ブロックを解析
  - 階層構造: Window → Controls → (Events/Methods/Properties/MenuHandlers)
  - コントロールごとにネストされたイベント/メソッドを表示

- **parseXojoMenuSymbols**: `.xojo_menu`ファイル向け
  - `Begin Menu`〜`End`ブロックを解析
  - 階層構造: Menu → DesktopMenuItem → (サブメニュー項目)
  - `Text`属性をメニュー項目の詳細情報として表示
  - セパレーター（`Text = "-"`）を特別扱い
  - メニュー項目タイプごとに適切なSymbolKindを適用

#### 2. syntaxes/xojo.tmLanguage.json
TextMateグラマー定義。以下の構文要素を定義:
- コメント: `'`, `//`, `#`, `REM`
- 文字列: ダブルクォート
- キーワード: 制御構文、宣言、型修飾子
- 関数: 宣言と呼び出し
- 変数: 宣言と代入

#### 3. language-configuration.json
エディター基本設定（ブラケット、オートクローズ、サラウンドペア）

## 重要な実装詳細

### シンボル解析の特徴
- **タグベース解析**: Xojo固有の`#tag Method`/`#tag EndMethod`形式をサポート
- **自由形式解析**: 直接記述された`Sub`/`Function`宣言も検出
- **階層的グループ化**: 遅延生成パターン(`ensureGroup`)で必要な時にグループシンボルを作成
- **範囲推定**: `End Sub`/`End Function`を検索してシンボル範囲を決定
- **Handlesキーワード検出**: `Handles`属性を持つ関数をMenuHandlersグループに自動分類

### 共通パーサーロジック

#### parseCommonTagBlocks ([extension.js:282-516](extension.js#L282-516))
両ファイルタイプで共有される#tagブロック解析ロジック:
- `#tag Method` / `#tag MenuHandler` → Handles判定でMenuHandlers/Methodsに分類
- `#tag Property` → Propertiesグループ
- `#tag Event` → Eventsグループまたはコントロール配下
- `#tag Constant` → Constantsグループ
- 自由形式の宣言も検出
- **階層対応**: `controlsByName`が配列形式の場合、パスマッチングで同名コントロールを区別
- **#tag Events検出**: コントロール名から最短パスの候補を選択し、`inEventsForRef.value`に`{name, path}`を設定

#### 統一されたグループ管理
両パーサーで`ensureGroup`パターンを使用:
- **Controls** (windowのみ): UI部品
- **Events**: イベントハンドラー
- **Methods**: 通常のメソッド/関数
- **MenuHandlers**: `Handles`キーワード付き関数
- **Properties**: プロパティ
- **Constants**: 定数

### ファイル判定ロジック
- 拡張子（`.xojo_window`, `.xojo_code`）
- コンテンツパターン（`Begin DesktopWindow`, `#tag Window`, `#tag Class/Module/Interface/Structure/Enum`）
- 複合条件で正確に分類

### オブジェクト種別とグループ構造（XOJO_OBJECT_TYPES）
- **Class**: Methods, Properties, Event Handlers, Constants, MenuHandlers
- **Module**: Methods, Properties, Constants
- **Interface**: Methods, Properties
- **Structure**: Properties
- **Enum**: グループなし（列挙値のみ）

### コントロール階層管理（parseXojoWindowSymbols）
- **InitialParent属性**: コントロールの`InitialParent`属性を読み取り親子関係を構築
- **3段階処理**:
  1. 全コントロールをスキャンし`controlsList`に収集（名前、親、シンボル）
  2. 再帰的にパスを構築し`controlPathMap`に格納（例: `["TabPanel1", "Label4"]`）
  3. `InitialParent`に基づき親コントロールの`children`に追加、または`Controls`グループに配置
- **階層配列構築**: `controlsByName`を`{name, path, symbol}`の配列形式で管理
- **ネスト対応**: DesktopTabPanel等のコンテナ内の子コントロールを正しく階層化
- **階層構造例**: Window → Controls → TabPanel1 → (Label4, scanIntervalText, ...)
- **#tag Events連携**: `parseCommonTagBlocks`に階層配列を渡し、パスマッチングで正しいコントロールにイベントを追加

### メンテナンス方針
- `parseXojoObjectSymbols`と`parseXojoWindowSymbols`は構造が類似
- タグ解析ロジックは`parseCommonTagBlocks`で共通化済み
- **重要**: 機能追加時は両方の関数に同じロジックを適用するか、`parseCommonTagBlocks`を拡張すること
- 新しいオブジェクト型を追加する場合は`XOJO_OBJECT_TYPES`テーブルを更新
- コントロール階層の変更時は`controlsList`の構築と親子付けロジック両方を更新

## 制限事項
- Xojo IDE との完全互換性はない
- 文字列内エスケープ処理は最小限
- コード補完機能は未実装