/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../../base/common/path.js';
import * as Json from '../../../../base/common/json.js';
import { Color } from '../../../../base/common/color.js';
import { ExtensionData, ITokenColorCustomizations, ITextMateThemingRule, IWorkbenchColorTheme, IColorMap, IThemeExtensionPoint, IColorCustomizations, ISemanticTokenRules, ISemanticTokenColorizationSetting, ISemanticTokenColorCustomizations, IThemeScopableCustomizations, IThemeScopedCustomizations, THEME_SCOPE_CLOSE_PAREN, THEME_SCOPE_OPEN_PAREN, themeScopeRegex, THEME_SCOPE_WILDCARD } from './workbenchThemeService.js';
import { convertSettings } from './themeCompatibility.js';
import * as nls from '../../../../nls.js';
import * as types from '../../../../base/common/types.js';
import * as resources from '../../../../base/common/resources.js';
import { Extensions as ColorRegistryExtensions, IColorRegistry, ColorIdentifier, editorBackground, editorForeground, DEFAULT_COLOR_CONFIG_VALUE } from '../../../../platform/theme/common/colorRegistry.js';
import { IFontTokenOptions, ITokenStyle, getThemeTypeSelector } from '../../../../platform/theme/common/themeService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { getParseErrorMessage } from '../../../../base/common/jsonErrorMessages.js';
import { URI } from '../../../../base/common/uri.js';
import { parse as parsePList } from './plistParser.js';
import { TokenStyle, SemanticTokenRule, ProbeScope, getTokenClassificationRegistry, TokenStyleValue, TokenStyleData, parseClassifierString } from '../../../../platform/theme/common/tokenClassificationRegistry.js';
import { MatcherWithPriority, Matcher, createMatchers } from './textMateScopeMatcher.js';
import { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { CharCode } from '../../../../base/common/charCode.js';
import { StorageScope, IStorageService, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ThemeConfiguration } from './themeConfiguration.js';
import { ColorScheme, ThemeTypeSelector } from '../../../../platform/theme/common/theme.js';
import { ColorId, FontStyle, MetadataConsts } from '../../../../editor/common/encodedTokenAttributes.js';
import { toStandardTokenType } from '../../../../editor/common/languages/supports/tokenization.js';

const colorRegistry = Registry.as<IColorRegistry>(ColorRegistryExtensions.ColorContribution);

const tokenClassificationRegistry = getTokenClassificationRegistry();

const tokenGroupToScopesMap = {
	comments: ['comment', 'punctuation.definition.comment'],
	strings: ['string', 'meta.embedded.assembly'],
	keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
	numbers: ['constant.numeric'],
	types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
	functions: ['entity.name.function', 'support.function'],
	variables: ['variable', 'entity.name.variable']
};


export type TokenStyleDefinition = SemanticTokenRule | ProbeScope[] | TokenStyleValue;
export type TokenStyleDefinitions = { [P in keyof TokenStyleData]?: TokenStyleDefinition | undefined };

export type TextMateThemingRuleDefinitions = { [P in keyof TokenStyleData]?: ITextMateThemingRule | undefined; } & { scope?: ProbeScope };

interface IColorOrDefaultMap {
	readonly [id: string]: Color | typeof DEFAULT_COLOR_CONFIG_VALUE;
}

interface IReadonlyColorMap {
	readonly [id: string]: Color;
}

/**
 * Initialization data for creating a ColorThemeData instance.
 * All fields are optional except id, label, and settingsId.
 */
interface ColorThemeDataInit {
	readonly id: string;
	readonly label: string;
	readonly settingsId: string;
	readonly description?: string;
	readonly isLoaded: boolean;
	readonly location?: URI;
	readonly watch?: boolean;
	readonly extensionData?: ExtensionData;
	readonly themeSemanticHighlighting?: boolean;
	readonly customSemanticHighlighting?: boolean;
	readonly customSemanticHighlightingDeprecated?: boolean;
	readonly themeTokenColors: readonly ITextMateThemingRule[];
	readonly customTokenColors: readonly ITextMateThemingRule[];
	readonly colorMap: IReadonlyColorMap;
	readonly customColorMap: IColorOrDefaultMap;
	readonly semanticTokenRules: readonly SemanticTokenRule[];
	readonly customSemanticTokenRules: readonly SemanticTokenRule[];
}

/**
 * Immutable color theme data. All fields are readonly.
 * To modify, use the `with*` methods which return new instances.
 */
export class ColorThemeData implements IWorkbenchColorTheme {

	static readonly STORAGE_KEY = 'colorThemeData';

	readonly id: string;
	readonly label: string;
	readonly settingsId: string;
	readonly description?: string;
	readonly isLoaded: boolean;
	readonly location?: URI; // only set for extension from the registry, not for themes restored from the storage
	readonly watch?: boolean;
	readonly extensionData?: ExtensionData;

	private readonly _themeSemanticHighlighting: boolean | undefined;
	private readonly _customSemanticHighlighting: boolean | undefined;
	private readonly _customSemanticHighlightingDeprecated: boolean | undefined;

	private readonly _themeTokenColors: readonly ITextMateThemingRule[];
	private readonly _customTokenColors: readonly ITextMateThemingRule[];
	private readonly _colorMap: IReadonlyColorMap;
	private readonly _customColorMap: IColorOrDefaultMap;

	private readonly _semanticTokenRules: readonly SemanticTokenRule[];
	private readonly _customSemanticTokenRules: readonly SemanticTokenRule[];

	// Computed caches - lazily populated, but logically derived from readonly state
	private _themeTokenScopeMatchers: Matcher<ProbeScope>[] | undefined;
	private _customTokenScopeMatchers: Matcher<ProbeScope>[] | undefined;
	private _textMateThemingRules: ITextMateThemingRule[] | undefined = undefined;
	private _tokenColorIndex: TokenColorIndex | undefined = undefined;
	private _tokenFontIndex: TokenFontIndex | undefined = undefined;

	private constructor(init: ColorThemeDataInit) {
		this.id = init.id;
		this.label = init.label;
		this.settingsId = init.settingsId;
		this.description = init.description;
		this.isLoaded = init.isLoaded;
		this.location = init.location;
		this.watch = init.watch;
		this.extensionData = init.extensionData;

		this._themeSemanticHighlighting = init.themeSemanticHighlighting;
		this._customSemanticHighlighting = init.customSemanticHighlighting;
		this._customSemanticHighlightingDeprecated = init.customSemanticHighlightingDeprecated;

		this._themeTokenColors = init.themeTokenColors;
		this._customTokenColors = init.customTokenColors;
		this._colorMap = init.colorMap;
		this._customColorMap = init.customColorMap;

		this._semanticTokenRules = init.semanticTokenRules;
		this._customSemanticTokenRules = init.customSemanticTokenRules;
	}

	private _toInit(): ColorThemeDataInit {
		return {
			id: this.id,
			label: this.label,
			settingsId: this.settingsId,
			description: this.description,
			isLoaded: this.isLoaded,
			location: this.location,
			watch: this.watch,
			extensionData: this.extensionData,
			themeSemanticHighlighting: this._themeSemanticHighlighting,
			customSemanticHighlighting: this._customSemanticHighlighting,
			customSemanticHighlightingDeprecated: this._customSemanticHighlightingDeprecated,
			themeTokenColors: this._themeTokenColors,
			customTokenColors: this._customTokenColors,
			colorMap: this._colorMap,
			customColorMap: this._customColorMap,
			semanticTokenRules: this._semanticTokenRules,
			customSemanticTokenRules: this._customSemanticTokenRules,
		};
	}

	get semanticHighlighting(): boolean {
		if (this._customSemanticHighlighting !== undefined) {
			return this._customSemanticHighlighting;
		}
		if (this._customSemanticHighlightingDeprecated !== undefined) {
			return this._customSemanticHighlightingDeprecated;
		}
		return !!this._themeSemanticHighlighting;
	}

	get tokenColors(): ITextMateThemingRule[] {
		if (!this._textMateThemingRules) {
			const result: ITextMateThemingRule[] = [];

			// the default rule (scope empty) is always the first rule. Ignore all other default rules.
			const foreground = this.getColor(editorForeground) || this.getDefault(editorForeground)!;
			const background = this.getColor(editorBackground) || this.getDefault(editorBackground)!;
			result.push({
				settings: {
					foreground: normalizeColor(foreground),
					background: normalizeColor(background)
				}
			});

			const state = { hasDefaultTokens: false };

			function addRule(rule: ITextMateThemingRule) {
				if (rule.scope && rule.settings) {
					if (rule.scope === 'token.info-token') {
						state.hasDefaultTokens = true;
					}
					const ruleSettings = rule.settings;
					result.push({
						scope: rule.scope, settings: {
							foreground: normalizeColor(ruleSettings.foreground),
							background: normalizeColor(ruleSettings.background),
							fontStyle: ruleSettings.fontStyle,
							fontSize: ruleSettings.fontSize,
							fontFamily: ruleSettings.fontFamily,
							lineHeight: ruleSettings.lineHeight
						}
					});
				}
			}

			this._themeTokenColors.forEach(addRule);
			// Add the custom colors after the theme colors
			// so that they will override them
			this._customTokenColors.forEach(addRule);

			if (!state.hasDefaultTokens) {
				defaultThemeColors[this.type].forEach(addRule);
			}
			this._textMateThemingRules = result;
		}
		return this._textMateThemingRules;
	}

	public getColor(colorId: ColorIdentifier, useDefault?: boolean): Color | undefined {
		const customColor = this._customColorMap[colorId];
		if (customColor instanceof Color) {
			return customColor;
		}
		if (customColor === undefined) { /* !== DEFAULT_COLOR_CONFIG_VALUE */
			const color = this._colorMap[colorId];
			if (color !== undefined) {
				return color;
			}
		}
		if (useDefault !== false) {
			return this.getDefault(colorId);
		}
		return undefined;
	}

	private getTokenStyle(type: string, modifiers: string[], language: string, useDefault = true, definitions: TokenStyleDefinitions = {}): TokenStyle | undefined {
		const result: any = {
			foreground: undefined,
			bold: undefined,
			underline: undefined,
			strikethrough: undefined,
			italic: undefined
		};
		const score = {
			foreground: -1,
			bold: -1,
			underline: -1,
			strikethrough: -1,
			italic: -1,
			fontFamily: -1,
			fontSize: -1,
			lineHeight: -1
		};

		function _processStyle(matchScore: number, style: TokenStyle, definition: TokenStyleDefinition) {
			if (style.foreground && score.foreground <= matchScore) {
				score.foreground = matchScore;
				result.foreground = style.foreground;
				definitions.foreground = definition;
			}
			for (const p of ['bold', 'underline', 'strikethrough', 'italic']) {
				const property = p as keyof TokenStyle;
				const info = style[property];
				if (info !== undefined) {
					if (score[property] <= matchScore) {
						score[property] = matchScore;
						result[property] = info;
						definitions[property] = definition;
					}
				}
			}
		}
		function _processSemanticTokenRule(rule: SemanticTokenRule) {
			const matchScore = rule.selector.match(type, modifiers, language);
			if (matchScore >= 0) {
				_processStyle(matchScore, rule.style, rule);
			}
		}

		this._semanticTokenRules.forEach(_processSemanticTokenRule);
		this._customSemanticTokenRules.forEach(_processSemanticTokenRule);

		let hasUndefinedStyleProperty = false;
		for (const k in score) {
			const key = k as keyof TokenStyle;
			if (score[key] === -1) {
				hasUndefinedStyleProperty = true;
			} else {
				score[key] = Number.MAX_VALUE; // set it to the max, so it won't be replaced by a default
			}
		}
		if (hasUndefinedStyleProperty) {
			for (const rule of tokenClassificationRegistry.getTokenStylingDefaultRules()) {
				const matchScore = rule.selector.match(type, modifiers, language);
				if (matchScore >= 0) {
					let style: TokenStyle | undefined;
					if (rule.defaults.scopesToProbe) {
						style = this.resolveScopes(rule.defaults.scopesToProbe);
						if (style) {
							_processStyle(matchScore, style, rule.defaults.scopesToProbe);
						}
					}
					if (!style && useDefault !== false) {
						const tokenStyleValue = rule.defaults[this.type];
						style = this.resolveTokenStyleValue(tokenStyleValue);
						if (style) {
							_processStyle(matchScore, style, tokenStyleValue!);
						}
					}
				}
			}
		}
		return TokenStyle.fromData(result);

	}

	/**
	 * @param tokenStyleValue Resolve a tokenStyleValue in the context of a theme
	 */
	public resolveTokenStyleValue(tokenStyleValue: TokenStyleValue | undefined): TokenStyle | undefined {
		if (tokenStyleValue === undefined) {
			return undefined;
		} else if (typeof tokenStyleValue === 'string') {
			const { type, modifiers, language } = parseClassifierString(tokenStyleValue, '');
			return this.getTokenStyle(type, modifiers, language);
		} else if (typeof tokenStyleValue === 'object') {
			return tokenStyleValue;
		}
		return undefined;
	}

	public getTokenColorIndex(): TokenColorIndex {
		// collect all colors that tokens can have
		if (!this._tokenColorIndex) {
			const index = new TokenColorIndex();
			this.tokenColors.forEach(rule => {
				index.add(rule.settings.foreground);
				index.add(rule.settings.background);
			});

			this._semanticTokenRules.forEach(r => index.add(r.style.foreground));
			tokenClassificationRegistry.getTokenStylingDefaultRules().forEach(r => {
				const defaultColor = r.defaults[this.type];
				if (defaultColor && typeof defaultColor === 'object') {
					index.add(defaultColor.foreground);
				}
			});
			this._customSemanticTokenRules.forEach(r => index.add(r.style.foreground));

			this._tokenColorIndex = index;
		}
		return this._tokenColorIndex;
	}


	public getTokenFontIndex(): TokenFontIndex {
		if (!this._tokenFontIndex) {
			const index = new TokenFontIndex();
			this.tokenColors.forEach(r => index.add(r.settings.fontFamily, r.settings.fontSize, r.settings.lineHeight));
			this._tokenFontIndex = index;
		}
		return this._tokenFontIndex;
	}

	public get tokenColorMap(): string[] {
		return this.getTokenColorIndex().asArray();
	}

	public get tokenFontMap(): IFontTokenOptions[] {
		return this.getTokenFontIndex().asArray();
	}

	public getTokenStyleMetadata(typeWithLanguage: string, modifiers: string[], defaultLanguage: string, useDefault = true, definitions: TokenStyleDefinitions = {}): ITokenStyle | undefined {
		const { type, language } = parseClassifierString(typeWithLanguage, defaultLanguage);
		const style = this.getTokenStyle(type, modifiers, language, useDefault, definitions);
		if (!style) {
			return undefined;
		}

		return {
			foreground: this.getTokenColorIndex().get(style.foreground),
			bold: style.bold,
			underline: style.underline,
			strikethrough: style.strikethrough,
			italic: style.italic,
		};
	}

	public getTokenStylingRuleScope(rule: SemanticTokenRule): 'setting' | 'theme' | undefined {
		if (this._customSemanticTokenRules.indexOf(rule) !== -1) {
			return 'setting';
		}
		if (this._semanticTokenRules.indexOf(rule) !== -1) {
			return 'theme';
		}
		return undefined;
	}

	public getDefault(colorId: ColorIdentifier): Color | undefined {
		return colorRegistry.resolveDefaultColor(colorId, this);
	}


	public resolveScopes(scopes: ProbeScope[], definitions?: TextMateThemingRuleDefinitions): TokenStyle | undefined {

		if (!this._themeTokenScopeMatchers) {
			this._themeTokenScopeMatchers = this._themeTokenColors.map(getScopeMatcher);
		}
		if (!this._customTokenScopeMatchers) {
			this._customTokenScopeMatchers = this._customTokenColors.map(getScopeMatcher);
		}

		for (const scope of scopes) {
			let foreground: string | undefined = undefined;
			let fontStyle: string | undefined = undefined;
			let foregroundScore = -1;
			let fontStyleScore = -1;
			let fontStyleThemingRule: ITextMateThemingRule | undefined = undefined;
			let foregroundThemingRule: ITextMateThemingRule | undefined = undefined;

			function findTokenStyleForScopeInScopes(scopeMatchers: Matcher<ProbeScope>[], themingRules: readonly ITextMateThemingRule[]) {
				for (let i = 0; i < scopeMatchers.length; i++) {
					const score = scopeMatchers[i](scope);
					if (score >= 0) {
						const themingRule = themingRules[i];
						const settings = themingRules[i].settings;
						if (score >= foregroundScore && settings.foreground) {
							foreground = settings.foreground;
							foregroundScore = score;
							foregroundThemingRule = themingRule;
						}
						if (score >= fontStyleScore && types.isString(settings.fontStyle)) {
							fontStyle = settings.fontStyle;
							fontStyleScore = score;
							fontStyleThemingRule = themingRule;
						}
					}
				}
			}
			findTokenStyleForScopeInScopes(this._themeTokenScopeMatchers!, this._themeTokenColors);
			findTokenStyleForScopeInScopes(this._customTokenScopeMatchers!, this._customTokenColors);
			if (foreground !== undefined || fontStyle !== undefined) {
				if (definitions) {
					definitions.foreground = foregroundThemingRule;
					definitions.bold = definitions.italic = definitions.underline = definitions.strikethrough = fontStyleThemingRule;
					definitions.scope = scope;
				}

				return TokenStyle.fromSettings(foreground, fontStyle);
			}
		}
		return undefined;
	}

	public defines(colorId: ColorIdentifier): boolean {
		const customColor = this._customColorMap[colorId];
		if (customColor instanceof Color) {
			return true;
		}
		return customColor === undefined /* !== DEFAULT_COLOR_CONFIG_VALUE */ && this._colorMap.hasOwnProperty(colorId);
	}

	/**
	 * Returns a new ColorThemeData with the given customizations applied.
	 */
	public withCustomizations(settings: ThemeConfiguration): ColorThemeData {
		return this
			.withCustomColors(settings.colorCustomizations)
			.withCustomTokenColors(settings.tokenColorCustomizations)
			.withCustomSemanticTokenColors(settings.semanticTokenColorCustomizations);
	}

	/**
	 * Returns a new ColorThemeData with the given color customizations applied.
	 */
	public withCustomColors(colors: IColorCustomizations): ColorThemeData {
		const customColorMap = this._computeCustomColorMap(colors);
		const init = this._toInit();
		return new ColorThemeData({
			...init,
			customColorMap,
		});
	}

	private _computeCustomColorMap(colors: IColorCustomizations): IColorOrDefaultMap {
		const customColorMap: { [id: string]: Color | typeof DEFAULT_COLOR_CONFIG_VALUE } = {};

		const addColors = (colors: IColorCustomizations) => {
			for (const id in colors) {
				const colorVal = colors[id];
				if (colorVal === DEFAULT_COLOR_CONFIG_VALUE) {
					customColorMap[id] = DEFAULT_COLOR_CONFIG_VALUE;
				} else if (typeof colorVal === 'string') {
					customColorMap[id] = Color.fromHex(colorVal);
				}
			}
		};

		addColors(colors);

		const themeSpecificColors = this.getThemeSpecificColors(colors) as IColorCustomizations;
		if (types.isObject(themeSpecificColors)) {
			addColors(themeSpecificColors);
		}

		return customColorMap;
	}

	/**
	 * Returns a new ColorThemeData with the given token color customizations applied.
	 */
	public withCustomTokenColors(customTokenColors: ITokenColorCustomizations): ColorThemeData {
		const { customTokenColorRules, customSemanticHighlightingDeprecated } = this._computeCustomTokenColors(customTokenColors);
		const init = this._toInit();
		return new ColorThemeData({
			...init,
			customTokenColors: customTokenColorRules,
			customSemanticHighlightingDeprecated,
		});
	}

	private _computeCustomTokenColors(customTokenColors: ITokenColorCustomizations): { customTokenColorRules: ITextMateThemingRule[]; customSemanticHighlightingDeprecated: boolean | undefined } {
		const customTokenColorRules: ITextMateThemingRule[] = [];
		let customSemanticHighlightingDeprecated: boolean | undefined = undefined;

		const addCustomTokenColors = (customTokenColors: ITokenColorCustomizations) => {
			// first the non-theme specific settings
			for (const tokenGroup in tokenGroupToScopesMap) {
				const group = tokenGroupToScopesMap[tokenGroup as keyof typeof tokenGroupToScopesMap];
				const value = customTokenColors[tokenGroup as keyof typeof tokenGroupToScopesMap];
				if (value) {
					const settings = typeof value === 'string' ? { foreground: value } : value;
					for (const scope of group) {
						customTokenColorRules.push({ scope, settings });
					}
				}
			}

			// the customTokenColors.textMateRules (if any)
			const textMateRules = customTokenColors.textMateRules;
			if (Array.isArray(textMateRules)) {
				for (const rule of textMateRules) {
					if (rule.scope && rule.settings) {
						customTokenColorRules.push(rule);
					}
				}
			}

			// deprecated semanticHighlighting flag
			if (customTokenColors.semanticHighlighting !== undefined) {
				customSemanticHighlightingDeprecated = customTokenColors.semanticHighlighting;
			}
		};

		// first add the non-theme specific settings
		addCustomTokenColors(customTokenColors);

		// append theme specific settings. Last rules will win.
		const themeSpecificTokenColors = this.getThemeSpecificColors(customTokenColors) as ITokenColorCustomizations;
		if (types.isObject(themeSpecificTokenColors)) {
			addCustomTokenColors(themeSpecificTokenColors);
		}

		return { customTokenColorRules, customSemanticHighlightingDeprecated };
	}

	/**
	 * Returns a new ColorThemeData with the given semantic token color customizations applied.
	 */
	public withCustomSemanticTokenColors(semanticTokenColors: ISemanticTokenColorCustomizations | undefined): ColorThemeData {
		const { customSemanticTokenRules, customSemanticHighlighting } = this._computeCustomSemanticTokenColors(semanticTokenColors);
		const init = this._toInit();
		return new ColorThemeData({
			...init,
			customSemanticTokenRules,
			customSemanticHighlighting,
		});
	}

	private _computeCustomSemanticTokenColors(semanticTokenColors: ISemanticTokenColorCustomizations | undefined): { customSemanticTokenRules: SemanticTokenRule[]; customSemanticHighlighting: boolean | undefined } {
		const customSemanticTokenRules: SemanticTokenRule[] = [];
		let customSemanticHighlighting: boolean | undefined = undefined;

		const readSemanticTokenRules = (tokenStylingRuleSection: ISemanticTokenRules) => {
			for (const key in tokenStylingRuleSection) {
				if (!this.isThemeScope(key)) {
					try {
						const rule = readSemanticTokenRule(key, tokenStylingRuleSection[key]);
						if (rule) {
							customSemanticTokenRules.push(rule);
						}
					} catch (e) {
						// invalid selector, ignore
					}
				}
			}
		};

		if (semanticTokenColors) {
			customSemanticHighlighting = semanticTokenColors.enabled;
			if (semanticTokenColors.rules) {
				readSemanticTokenRules(semanticTokenColors.rules);
			}
			const themeSpecificColors = this.getThemeSpecificColors(semanticTokenColors) as ISemanticTokenColorCustomizations;
			if (types.isObject(themeSpecificColors)) {
				if (themeSpecificColors.enabled !== undefined) {
					customSemanticHighlighting = themeSpecificColors.enabled;
				}
				if (themeSpecificColors.rules) {
					readSemanticTokenRules(themeSpecificColors.rules);
				}
			}
		}

		return { customSemanticTokenRules, customSemanticHighlighting };
	}

	public isThemeScope(key: string): boolean {
		return key.charAt(0) === THEME_SCOPE_OPEN_PAREN && key.charAt(key.length - 1) === THEME_SCOPE_CLOSE_PAREN;
	}

	public isThemeScopeMatch(themeId: string): boolean {
		const themeIdFirstChar = themeId.charAt(0);
		const themeIdLastChar = themeId.charAt(themeId.length - 1);
		const themeIdPrefix = themeId.slice(0, -1);
		const themeIdInfix = themeId.slice(1, -1);
		const themeIdSuffix = themeId.slice(1);
		return themeId === this.settingsId
			|| (this.settingsId.includes(themeIdInfix) && themeIdFirstChar === THEME_SCOPE_WILDCARD && themeIdLastChar === THEME_SCOPE_WILDCARD)
			|| (this.settingsId.startsWith(themeIdPrefix) && themeIdLastChar === THEME_SCOPE_WILDCARD)
			|| (this.settingsId.endsWith(themeIdSuffix) && themeIdFirstChar === THEME_SCOPE_WILDCARD);
	}

	public getThemeSpecificColors(colors: IThemeScopableCustomizations): IThemeScopedCustomizations | undefined {
		let themeSpecificColors: IThemeScopedCustomizations | undefined;
		for (const key in colors) {
			const scopedColors = colors[key];
			if (this.isThemeScope(key) && scopedColors instanceof Object && !Array.isArray(scopedColors)) {
				const themeScopeList = key.match(themeScopeRegex) || [];
				for (const themeScope of themeScopeList) {
					const themeId = themeScope.substring(1, themeScope.length - 1);
					if (this.isThemeScopeMatch(themeId)) {
						if (!themeSpecificColors) {
							themeSpecificColors = {};
						}
						const scopedThemeSpecificColors = scopedColors as IThemeScopedCustomizations;
						for (const subkey in scopedThemeSpecificColors) {
							const originalColors = themeSpecificColors[subkey];
							const overrideColors = scopedThemeSpecificColors[subkey];
							if (Array.isArray(originalColors) && Array.isArray(overrideColors)) {
								themeSpecificColors[subkey] = originalColors.concat(overrideColors);
							} else if (overrideColors) {
								themeSpecificColors[subkey] = overrideColors;
							}
						}
					}
				}
			}
		}
		return themeSpecificColors;
	}

	/**
	 * Returns true if this theme produces the same visual output as the other theme.
	 * This compares all colors, token colors, and semantic token rules.
	 */
	public equals(other: ColorThemeData): boolean {
		if (this === other) {
			return true;
		}
		if (this.id !== other.id || this.settingsId !== other.settingsId) {
			return false;
		}
		if (this.semanticHighlighting !== other.semanticHighlighting) {
			return false;
		}
		// Compare color maps
		const colorKeys = Object.keys(this._colorMap);
		const otherColorKeys = Object.keys(other._colorMap);
		if (colorKeys.length !== otherColorKeys.length) {
			return false;
		}
		for (const key of colorKeys) {
			if (!this._colorMap[key].equals(other._colorMap[key])) {
				return false;
			}
		}
		// Compare custom color maps
		const customColorKeys = Object.keys(this._customColorMap);
		const otherCustomColorKeys = Object.keys(other._customColorMap);
		if (customColorKeys.length !== otherCustomColorKeys.length) {
			return false;
		}
		for (const key of customColorKeys) {
			const thisColor = this._customColorMap[key];
			const otherColor = other._customColorMap[key];
			if (thisColor === DEFAULT_COLOR_CONFIG_VALUE || otherColor === DEFAULT_COLOR_CONFIG_VALUE) {
				if (thisColor !== otherColor) {
					return false;
				}
			} else if (!thisColor.equals(otherColor)) {
				return false;
			}
		}
		// Compare token colors
		if (!arraysEqual(this._themeTokenColors, other._themeTokenColors, tokenColorRuleEqual)) {
			return false;
		}
		if (!arraysEqual(this._customTokenColors, other._customTokenColors, tokenColorRuleEqual)) {
			return false;
		}
		// Compare semantic token rules (by length and content)
		if (!arraysEqual(this._semanticTokenRules, other._semanticTokenRules, semanticTokenRuleEqual)) {
			return false;
		}
		if (!arraysEqual(this._customSemanticTokenRules, other._customSemanticTokenRules, semanticTokenRuleEqual)) {
			return false;
		}
		return true;
	}

	/**
	 * Ensures this theme is loaded. Returns a loaded version of this theme data.
	 * If already loaded, returns this instance.
	 */
	public ensureLoaded(extensionResourceLoaderService: IExtensionResourceLoaderService): Promise<ColorThemeData> {
		return !this.isLoaded ? this._load(extensionResourceLoaderService) : Promise.resolve(this);
	}

	/**
	 * Reloads this theme from disk. Returns a new loaded instance.
	 */
	public reload(extensionResourceLoaderService: IExtensionResourceLoaderService): Promise<ColorThemeData> {
		return this._load(extensionResourceLoaderService);
	}

	private async _load(extensionResourceLoaderService: IExtensionResourceLoaderService): Promise<ColorThemeData> {
		if (!this.location) {
			return this;
		}

		const result: { textMateRules: ITextMateThemingRule[]; colors: IColorMap; semanticTokenRules: SemanticTokenRule[]; semanticHighlighting: boolean } = {
			colors: {},
			textMateRules: [],
			semanticTokenRules: [],
			semanticHighlighting: false
		};
		await _loadColorTheme(extensionResourceLoaderService, this.location, result);

		const init = this._toInit();
		return new ColorThemeData({
			...init,
			isLoaded: true,
			themeSemanticHighlighting: result.semanticHighlighting,
			colorMap: result.colors,
			themeTokenColors: result.textMateRules,
			semanticTokenRules: result.semanticTokenRules,
		});
	}

	toStorage(storageService: IStorageService) {
		const colorMapData: { [key: string]: string } = {};
		for (const key in this._colorMap) {
			colorMapData[key] = Color.Format.CSS.formatHexA(this._colorMap[key], true);
		}
		// no need to persist custom colors, they will be taken from the settings
		const value = JSON.stringify({
			id: this.id,
			label: this.label,
			settingsId: this.settingsId,
			themeTokenColors: this._themeTokenColors.map(tc => ({ settings: tc.settings, scope: tc.scope })), // don't persist names
			semanticTokenRules: this._semanticTokenRules.map(SemanticTokenRule.toJSONObject),
			extensionData: ExtensionData.toJSONObject(this.extensionData),
			themeSemanticHighlighting: this._themeSemanticHighlighting,
			colorMap: colorMapData,
			watch: this.watch
		});

		// roam persisted color theme colors. Don't enable for icons as they contain references to fonts and images.
		storageService.store(ColorThemeData.STORAGE_KEY, value, StorageScope.PROFILE, StorageTarget.USER);
	}

	get themeTypeSelector(): ThemeTypeSelector {
		return this.classNames[0] as ThemeTypeSelector;
	}

	get classNames(): string[] {
		return this.id.split(' ');
	}

	get type(): ColorScheme {
		switch (this.themeTypeSelector) {
			case ThemeTypeSelector.VS: return ColorScheme.LIGHT;
			case ThemeTypeSelector.HC_BLACK: return ColorScheme.HIGH_CONTRAST_DARK;
			case ThemeTypeSelector.HC_LIGHT: return ColorScheme.HIGH_CONTRAST_LIGHT;
			default: return ColorScheme.DARK;
		}
	}

	// constructors

	static createUnloadedThemeForThemeType(themeType: ColorScheme, colorMap?: { [id: string]: string }): ColorThemeData {
		return ColorThemeData.createUnloadedTheme(getThemeTypeSelector(themeType), colorMap);
	}

	static createUnloadedTheme(id: string, colorMap?: { [id: string]: string }): ColorThemeData {
		const colors: { [id: string]: Color } = {};
		if (colorMap) {
			for (const colorId in colorMap) {
				colors[colorId] = Color.fromHex(colorMap[colorId]);
			}
		}
		return new ColorThemeData({
			id,
			label: '',
			settingsId: '__' + id,
			isLoaded: false,
			watch: false,
			themeTokenColors: [],
			customTokenColors: [],
			colorMap: colors,
			customColorMap: {},
			semanticTokenRules: [],
			customSemanticTokenRules: [],
		});
	}

	static createLoadedEmptyTheme(id: string, settingsId: string): ColorThemeData {
		return new ColorThemeData({
			id,
			label: '',
			settingsId,
			isLoaded: true,
			watch: false,
			themeTokenColors: [],
			customTokenColors: [],
			colorMap: {},
			customColorMap: {},
			semanticTokenRules: [],
			customSemanticTokenRules: [],
		});
	}

	static fromStorageData(storageService: IStorageService): ColorThemeData | undefined {
		const input = storageService.get(ColorThemeData.STORAGE_KEY, StorageScope.PROFILE);
		if (!input) {
			return undefined;
		}
		try {
			const data = JSON.parse(input);

			if (!data.id || !data.settingsId) {
				return undefined;
			}

			const colorMap: { [id: string]: Color } = {};
			if (data.colorMap) {
				for (const id in data.colorMap) {
					colorMap[id] = Color.fromHex(data.colorMap[id]);
				}
			}

			const semanticTokenRules: SemanticTokenRule[] = [];
			if (Array.isArray(data.semanticTokenRules)) {
				for (const d of data.semanticTokenRules) {
					const rule = SemanticTokenRule.fromJSONObject(tokenClassificationRegistry, d);
					if (rule) {
						semanticTokenRules.push(rule);
					}
				}
			}

			return new ColorThemeData({
				id: data.id,
				label: data.label || '',
				settingsId: data.settingsId,
				isLoaded: true,
				watch: data.watch,
				themeSemanticHighlighting: data.themeSemanticHighlighting,
				extensionData: ExtensionData.fromJSONObject(data.extensionData),
				themeTokenColors: data.themeTokenColors || [],
				customTokenColors: [],
				colorMap,
				customColorMap: {},
				semanticTokenRules,
				customSemanticTokenRules: [],
			});
		} catch (e) {
			return undefined;
		}
	}

	static fromExtensionTheme(theme: IThemeExtensionPoint, colorThemeLocation: URI, extensionData: ExtensionData): ColorThemeData {
		const baseTheme: string = theme['uiTheme'] || 'vs-dark';
		const themeSelector = toCSSSelector(extensionData.extensionId, theme.path);
		const id = `${baseTheme} ${themeSelector}`;
		const label = theme.label || basename(theme.path);
		const settingsId = theme.id || label;
		return new ColorThemeData({
			id,
			label,
			settingsId,
			description: theme.description,
			isLoaded: false,
			watch: theme._watch === true,
			location: colorThemeLocation,
			extensionData,
			themeTokenColors: [],
			customTokenColors: [],
			colorMap: {},
			customColorMap: {},
			semanticTokenRules: [],
			customSemanticTokenRules: [],
		});
	}
}

function toCSSSelector(extensionId: string, path: string) {
	if (path.startsWith('./')) {
		path = path.substr(2);
	}
	let str = `${extensionId}-${path}`;

	//remove all characters that are not allowed in css
	str = str.replace(/[^_a-zA-Z0-9-]/g, '-');
	if (str.charAt(0).match(/[0-9-]/)) {
		str = '_' + str;
	}
	return str;
}

async function _loadColorTheme(extensionResourceLoaderService: IExtensionResourceLoaderService, themeLocation: URI, result: { textMateRules: ITextMateThemingRule[]; colors: IColorMap; semanticTokenRules: SemanticTokenRule[]; semanticHighlighting: boolean }): Promise<any> {
	if (resources.extname(themeLocation) === '.json') {
		const content = await extensionResourceLoaderService.readExtensionResource(themeLocation);
		const errors: Json.ParseError[] = [];
		const contentValue = Json.parse(content, errors);
		if (errors.length > 0) {
			return Promise.reject(new Error(nls.localize('error.cannotparsejson', "Problems parsing JSON theme file: {0}", errors.map(e => getParseErrorMessage(e.error)).join(', '))));
		} else if (Json.getNodeType(contentValue) !== 'object') {
			return Promise.reject(new Error(nls.localize('error.invalidformat', "Invalid format for JSON theme file: Object expected.")));
		}
		if (contentValue.include) {
			await _loadColorTheme(extensionResourceLoaderService, resources.joinPath(resources.dirname(themeLocation), contentValue.include), result);
		}
		if (Array.isArray(contentValue.settings)) {
			convertSettings(contentValue.settings, result);
			return null;
		}
		result.semanticHighlighting = result.semanticHighlighting || contentValue.semanticHighlighting;
		const colors = contentValue.colors;
		if (colors) {
			if (typeof colors !== 'object') {
				return Promise.reject(new Error(nls.localize({ key: 'error.invalidformat.colors', comment: ['{0} will be replaced by a path. Values in quotes should not be translated.'] }, "Problem parsing color theme file: {0}. Property 'colors' is not of type 'object'.", themeLocation.toString())));
			}
			// new JSON color themes format
			for (const colorId in colors) {
				const colorVal = colors[colorId];
				if (colorVal === DEFAULT_COLOR_CONFIG_VALUE) { // ignore colors that are set to to default
					delete result.colors[colorId];
				} else if (typeof colorVal === 'string') {
					result.colors[colorId] = Color.fromHex(colors[colorId]);
				}
			}
		}
		const tokenColors = contentValue.tokenColors;
		if (tokenColors) {
			if (Array.isArray(tokenColors)) {
				result.textMateRules.push(...tokenColors);
			} else if (typeof tokenColors === 'string') {
				await _loadSyntaxTokens(extensionResourceLoaderService, resources.joinPath(resources.dirname(themeLocation), tokenColors), result);
			} else {
				return Promise.reject(new Error(nls.localize({ key: 'error.invalidformat.tokenColors', comment: ['{0} will be replaced by a path. Values in quotes should not be translated.'] }, "Problem parsing color theme file: {0}. Property 'tokenColors' should be either an array specifying colors or a path to a TextMate theme file", themeLocation.toString())));
			}
		}
		const semanticTokenColors = contentValue.semanticTokenColors;
		if (semanticTokenColors && typeof semanticTokenColors === 'object') {
			for (const key in semanticTokenColors) {
				try {
					const rule = readSemanticTokenRule(key, semanticTokenColors[key]);
					if (rule) {
						result.semanticTokenRules.push(rule);
					}
				} catch (e) {
					return Promise.reject(new Error(nls.localize({ key: 'error.invalidformat.semanticTokenColors', comment: ['{0} will be replaced by a path. Values in quotes should not be translated.'] }, "Problem parsing color theme file: {0}. Property 'semanticTokenColors' contains a invalid selector", themeLocation.toString())));
				}
			}
		}
	} else {
		return _loadSyntaxTokens(extensionResourceLoaderService, themeLocation, result);
	}
}

function _loadSyntaxTokens(extensionResourceLoaderService: IExtensionResourceLoaderService, themeLocation: URI, result: { textMateRules: ITextMateThemingRule[]; colors: IColorMap }): Promise<any> {
	return extensionResourceLoaderService.readExtensionResource(themeLocation).then(content => {
		try {
			const contentValue = parsePList(content);
			const settings: ITextMateThemingRule[] = contentValue.settings;
			if (!Array.isArray(settings)) {
				return Promise.reject(new Error(nls.localize('error.plist.invalidformat', "Problem parsing tmTheme file: {0}. 'settings' is not array.")));
			}
			convertSettings(settings, result);
			return Promise.resolve(null);
		} catch (e) {
			return Promise.reject(new Error(nls.localize('error.cannotparse', "Problems parsing tmTheme file: {0}", e.message)));
		}
	}, error => {
		return Promise.reject(new Error(nls.localize('error.cannotload', "Problems loading tmTheme file {0}: {1}", themeLocation.toString(), error.message)));
	});
}

const defaultThemeColors: { [baseTheme: string]: ITextMateThemingRule[] } = {
	'light': [
		{ scope: 'token.info-token', settings: { foreground: '#316bcd' } },
		{ scope: 'token.warn-token', settings: { foreground: '#cd9731' } },
		{ scope: 'token.error-token', settings: { foreground: '#cd3131' } },
		{ scope: 'token.debug-token', settings: { foreground: '#800080' } }
	],
	'dark': [
		{ scope: 'token.info-token', settings: { foreground: '#6796e6' } },
		{ scope: 'token.warn-token', settings: { foreground: '#cd9731' } },
		{ scope: 'token.error-token', settings: { foreground: '#f44747' } },
		{ scope: 'token.debug-token', settings: { foreground: '#b267e6' } }
	],
	'hcLight': [
		{ scope: 'token.info-token', settings: { foreground: '#316bcd' } },
		{ scope: 'token.warn-token', settings: { foreground: '#cd9731' } },
		{ scope: 'token.error-token', settings: { foreground: '#cd3131' } },
		{ scope: 'token.debug-token', settings: { foreground: '#800080' } }
	],
	'hcDark': [
		{ scope: 'token.info-token', settings: { foreground: '#6796e6' } },
		{ scope: 'token.warn-token', settings: { foreground: '#008000' } },
		{ scope: 'token.error-token', settings: { foreground: '#FF0000' } },
		{ scope: 'token.debug-token', settings: { foreground: '#b267e6' } }
	]
};

const noMatch = (_scope: ProbeScope) => -1;

function nameMatcher(identifiers: string[], scopes: ProbeScope): number {
	if (scopes.length < identifiers.length) {
		return -1;
	}

	let score: number | undefined = undefined;
	const every = identifiers.every((identifier) => {
		for (let i = scopes.length - 1; i >= 0; i--) {
			if (scopesAreMatching(scopes[i], identifier)) {
				score = (i + 1) * 0x10000 + identifier.length;
				return true;
			}
		}
		return false;
	});
	return every && score !== undefined ? score : -1;
}
function scopesAreMatching(thisScopeName: string, scopeName: string): boolean {
	if (!thisScopeName) {
		return false;
	}
	if (thisScopeName === scopeName) {
		return true;
	}
	const len = scopeName.length;
	return thisScopeName.length > len && thisScopeName.substr(0, len) === scopeName && thisScopeName[len] === '.';
}

function getScopeMatcher(rule: ITextMateThemingRule): Matcher<ProbeScope> {
	const ruleScope = rule.scope;
	if (!ruleScope || !rule.settings) {
		return noMatch;
	}
	const matchers: MatcherWithPriority<ProbeScope>[] = [];
	if (Array.isArray(ruleScope)) {
		for (const rs of ruleScope) {
			createMatchers(rs, nameMatcher, matchers);
		}
	} else {
		createMatchers(ruleScope, nameMatcher, matchers);
	}

	if (matchers.length === 0) {
		return noMatch;
	}
	return (scope: ProbeScope) => {
		let max = matchers[0].matcher(scope);
		for (let i = 1; i < matchers.length; i++) {
			max = Math.max(max, matchers[i].matcher(scope));
		}
		return max;
	};
}

function readSemanticTokenRule(selectorString: string, settings: ISemanticTokenColorizationSetting | string | boolean | undefined): SemanticTokenRule | undefined {
	const selector = tokenClassificationRegistry.parseTokenSelector(selectorString);
	let style: TokenStyle | undefined;
	if (typeof settings === 'string') {
		style = TokenStyle.fromSettings(settings, undefined);
	} else if (isSemanticTokenColorizationSetting(settings)) {
		style = TokenStyle.fromSettings(settings.foreground, settings.fontStyle, settings.bold, settings.underline, settings.strikethrough, settings.italic);
	}
	if (style) {
		return { selector, style };
	}
	return undefined;
}

function isSemanticTokenColorizationSetting(style: any): style is ISemanticTokenColorizationSetting {
	return style && (types.isString(style.foreground) || types.isString(style.fontStyle) || types.isBoolean(style.italic)
		|| types.isBoolean(style.underline) || types.isBoolean(style.strikethrough) || types.isBoolean(style.bold));
}

export function findMetadata(colorThemeData: ColorThemeData, captureNames: string[], languageId: number, bracket: boolean): number {
	let metadata = 0;

	metadata |= (languageId << MetadataConsts.LANGUAGEID_OFFSET);

	const definitions: TextMateThemingRuleDefinitions = {};
	const tokenStyle = colorThemeData.resolveScopes([captureNames], definitions);

	if (captureNames.length > 0) {
		const standardToken = toStandardTokenType(captureNames[captureNames.length - 1]);
		metadata |= (standardToken << MetadataConsts.TOKEN_TYPE_OFFSET);
	}

	const fontStyle = definitions.foreground?.settings.fontStyle || definitions.bold?.settings.fontStyle;
	if (fontStyle?.includes('italic')) {
		metadata |= FontStyle.Italic | MetadataConsts.ITALIC_MASK;
	}
	if (fontStyle?.includes('bold')) {
		metadata |= FontStyle.Bold | MetadataConsts.BOLD_MASK;
	}
	if (fontStyle?.includes('underline')) {
		metadata |= FontStyle.Underline | MetadataConsts.UNDERLINE_MASK;
	}
	if (fontStyle?.includes('strikethrough')) {
		metadata |= FontStyle.Strikethrough | MetadataConsts.STRIKETHROUGH_MASK;
	}

	const foreground = tokenStyle?.foreground;
	const tokenStyleForeground = (foreground !== undefined) ? colorThemeData.getTokenColorIndex().get(foreground) : ColorId.DefaultForeground;
	metadata |= tokenStyleForeground << MetadataConsts.FOREGROUND_OFFSET;

	if (bracket) {
		metadata |= MetadataConsts.BALANCED_BRACKETS_MASK;
	}

	return metadata;
}

class TokenColorIndex {

	private _lastColorId: number;
	private _id2color: string[];
	private _color2id: { [color: string]: number };

	constructor() {
		this._lastColorId = 0;
		this._id2color = [];
		this._color2id = Object.create(null);
	}

	public add(color: string | Color | undefined): number {
		color = normalizeColor(color);
		if (color === undefined) {
			return 0;
		}

		let value = this._color2id[color];
		if (value) {
			return value;
		}
		value = ++this._lastColorId;
		this._color2id[color] = value;
		this._id2color[value] = color;
		return value;
	}

	public get(color: string | Color | undefined): number {
		color = normalizeColor(color);
		if (color === undefined) {
			return 0;
		}
		const value = this._color2id[color];
		if (value) {
			return value;
		}
		console.log(`Color ${color} not in index.`);
		return 0;
	}

	public asArray(): string[] {
		return this._id2color.slice(0);
	}
}

class TokenFontIndex {

	private _lastFontId: number;
	private _id2font: IFontTokenOptions[];
	private _font2id: Map<IFontTokenOptions, number>;

	constructor() {
		this._lastFontId = 0;
		this._id2font = [];
		this._font2id = new Map();
	}

	public add(fontFamily: string | undefined, fontSizeMultiplier: number | undefined, lineHeightMultiplier: number | undefined): number {
		const font: IFontTokenOptions = { fontFamily, fontSizeMultiplier, lineHeightMultiplier };
		let value = this._font2id.get(font);
		if (value) {
			return value;
		}
		value = ++this._lastFontId;
		this._font2id.set(font, value);
		this._id2font[value] = font;
		return value;
	}

	public get(font: IFontTokenOptions): number {
		const value = this._font2id.get(font);
		if (value) {
			return value;
		}
		return 0;
	}

	public asArray(): IFontTokenOptions[] {
		return this._id2font.slice(0);
	}
}

function normalizeColor(color: string | Color | undefined | null): string | undefined {
	if (!color) {
		return undefined;
	}
	if (typeof color !== 'string') {
		color = Color.Format.CSS.formatHexA(color, true);
	}
	const len = color.length;
	if (color.charCodeAt(0) !== CharCode.Hash || (len !== 4 && len !== 5 && len !== 7 && len !== 9)) {
		return undefined;
	}
	const result = [CharCode.Hash];

	for (let i = 1; i < len; i++) {
		const upper = hexUpper(color.charCodeAt(i));
		if (!upper) {
			return undefined;
		}
		result.push(upper);
		if (len === 4 || len === 5) {
			result.push(upper);
		}
	}

	if (result.length === 9 && result[7] === CharCode.F && result[8] === CharCode.F) {
		result.length = 7;
	}
	return String.fromCharCode(...result);
}

function hexUpper(charCode: CharCode): number {
	if (charCode >= CharCode.Digit0 && charCode <= CharCode.Digit9 || charCode >= CharCode.A && charCode <= CharCode.F) {
		return charCode;
	} else if (charCode >= CharCode.a && charCode <= CharCode.f) {
		return charCode - CharCode.a + CharCode.A;
	}
	return 0;
}

function arraysEqual<T>(a: readonly T[], b: readonly T[], equals: (a: T, b: T) => boolean = (a, b) => a === b): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (!equals(a[i], b[i])) {
			return false;
		}
	}
	return true;
}

function tokenColorRuleEqual(a: ITextMateThemingRule, b: ITextMateThemingRule): boolean {
	if (a.scope !== b.scope && !(Array.isArray(a.scope) && Array.isArray(b.scope) && arraysEqual(a.scope, b.scope))) {
		return false;
	}
	const aSettings = a.settings;
	const bSettings = b.settings;
	return aSettings.foreground === bSettings.foreground
		&& aSettings.background === bSettings.background
		&& aSettings.fontStyle === bSettings.fontStyle
		&& aSettings.fontFamily === bSettings.fontFamily
		&& aSettings.fontSize === bSettings.fontSize
		&& aSettings.lineHeight === bSettings.lineHeight;
}

function semanticTokenRuleEqual(a: SemanticTokenRule, b: SemanticTokenRule): boolean {
	return a.selector.id === b.selector.id && TokenStyle.equals(a.style, b.style);
}
