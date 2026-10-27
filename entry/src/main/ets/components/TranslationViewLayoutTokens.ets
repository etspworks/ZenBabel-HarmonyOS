// Explicit application values from TranslationView.swift:344,1611,1773-1840,3287.
export { LayoutTokens as TranslationViewLayoutTokens } from '../model/TranslationModels';
export class TranslationViewVisualTokens {
  static readonly wrapperRadius: number = 18;
  static readonly dockRadius: number = 16;
  static readonly outerHorizontal: number = 12;
  static readonly outerTop: number = 8;
  static readonly outerBottom: number = 2;
  static readonly statusHeight: number = 22;
  static readonly editorInner: number = 8;
  static readonly outputTop: number = 62;
  static readonly primaryWidth: number = 60;
  static readonly primaryHeight: number = 34;
  static readonly inactiveWidth: number = 44;
  static readonly inactiveHeight: number = 28;
  static readonly activeGlyph: number = 20;
  static readonly inactiveGlyph: number = 15;
  static readonly sourceDockGap: number = 4;
  static readonly toolbarGap: number = 8;
  // HarmonyOS-only: the source toolbar and the output bar share this width, so they meet as one pill at the
  // divider in portrait and line up across the two panes in landscape
  // (4 slots x primaryWidth + 3 x sourceDockGap + 24 padding).
  static readonly dockWidth: number = 276;
  static readonly dockHeight: number = 50; // the output bar's natural height (36 vp Share button + 2 x 7 padding)
  static readonly selectedHighlight: string = '#66FFBE38';
  static readonly lightGradientTop: string = '#FAE6E6E8';
  static readonly lightGradientBottom: string = '#FAEDE6E0';
  static readonly darkGradientTop: string = '#1A1F24';
  static readonly darkGradientBottom: string = '#293038';
}
