# Changelog

## 0.9.0

-   Added outline support for the menu hierarchy in `.xojo_menu` files.
-   Implemented `parseXojoMenuSymbols` to parse the nested structure `Begin Menu` → `Begin DesktopMenuItem`.
-   Assigned a SymbolKind per menu item type (DesktopMenuItem, DesktopQuitMenuItem, DesktopApplicationMenuItem, etc.).
-   Reads the `Text` attribute and shows it as the detail for each menu item.
-   Represents separators (`Text = "-"`) as `SymbolKind.Null`.
-   Verified menu hierarchy display with the `MainMenuBar.xojo_menu` sample.

## 0.8.0

-   Implemented multi-level handling for `#tag Events` blocks so events of nested controls are correctly parented.
-   Extended `parseCommonTagBlocks` to support hierarchical array-style `controlsByName`.
-   Automatically builds control paths (parent chains) and prefers the nearest scope when duplicate control names exist.
-   Manages control info in `{name, path, symbol}` form inside `parseXojoWindowSymbols`.
-   Verified hierarchical events using the `settingWindow.xojo_window` sample's `#tag Events` blocks.

## 0.7.0

-   Enhanced `.xojo_window` control hierarchy detection to display parent-child relationships based on the `InitialParent` attribute.
-   Improved nesting so children appear properly under container controls like DesktopTabPanel.
-   Added the `settingWindow.xojo_window` sample to provide a test environment for hierarchical control structures.

## 0.6.0

-   Expanded `.xojo_code` outline to support top-level objects other than Class (Module / Interface / Structure / Enum).
-   Implemented `parseXojoObjectSymbols` to automatically apply suitable grouping per object type.
-   Added sample files: `SampleModule.xojo_code`, `SampleInterface.xojo_code`, `SampleStructure.xojo_code`, `SampleEnum.xojo_code`.

## 0.5.0

-   Added Xojo Reload and Run feature (macOS only).
-   Added F5 execution via a debug provider.

## 0.1.0

-   Initial release: minimal highlighting (comments / strings / numbers / keywords / types).
