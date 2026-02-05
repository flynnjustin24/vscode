/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ColorScheme } from '../../common/theme.js';
import { ResolvedColorTheme } from '../../common/themeService.js';
import { TestColorTheme } from './testThemeService.js';

suite('ResolvedColorTheme', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('from() creates snapshot with specified colors', () => {
		const theme = new TestColorTheme({
			'editor.background': '#1e1e1e',
			'editor.foreground': '#d4d4d4',
		}, ColorScheme.DARK);

		const resolved = ResolvedColorTheme.from(theme, ['editor.background', 'editor.foreground']);

		assert.strictEqual(resolved.type, ColorScheme.DARK);
		assert.strictEqual(resolved.label, 'test');
		assert.strictEqual(resolved.getColor('editor.background')?.toString(), '#1e1e1e');
		assert.strictEqual(resolved.getColor('editor.foreground')?.toString(), '#d4d4d4');
	});

	test('create() builds theme directly from color data', () => {
		const resolved = ResolvedColorTheme.create(
			ColorScheme.LIGHT,
			'My Theme',
			{ 'editor.background': '#ffffff', 'editor.foreground': '#000000' }
		);

		assert.strictEqual(resolved.type, ColorScheme.LIGHT);
		assert.strictEqual(resolved.label, 'My Theme');
		assert.strictEqual(resolved.getColorHex('editor.background'), '#ffffff');
		assert.strictEqual(resolved.getColorHex('editor.foreground'), '#000000');
	});

	test('equals() returns true for identical themes', () => {
		const theme1 = new TestColorTheme({
			'editor.background': '#1e1e1e',
			'editor.foreground': '#d4d4d4',
		}, ColorScheme.DARK);

		const theme2 = new TestColorTheme({
			'editor.background': '#1e1e1e',
			'editor.foreground': '#d4d4d4',
		}, ColorScheme.DARK);

		const colorIds = ['editor.background', 'editor.foreground'];
		const resolved1 = ResolvedColorTheme.from(theme1, colorIds);
		const resolved2 = ResolvedColorTheme.from(theme2, colorIds);

		assert.strictEqual(resolved1.equals(resolved2), true);
	});

	test('equals() returns false for different colors', () => {
		const theme1 = new TestColorTheme({
			'editor.background': '#1e1e1e',
		}, ColorScheme.DARK);

		const theme2 = new TestColorTheme({
			'editor.background': '#ffffff',
		}, ColorScheme.DARK);

		const colorIds = ['editor.background'];
		const resolved1 = ResolvedColorTheme.from(theme1, colorIds);
		const resolved2 = ResolvedColorTheme.from(theme2, colorIds);

		assert.strictEqual(resolved1.equals(resolved2), false);
	});

	test('equals() returns false for different theme types', () => {
		const theme1 = new TestColorTheme({
			'editor.background': '#1e1e1e',
		}, ColorScheme.DARK);

		const theme2 = new TestColorTheme({
			'editor.background': '#1e1e1e',
		}, ColorScheme.LIGHT);

		const colorIds = ['editor.background'];
		const resolved1 = ResolvedColorTheme.from(theme1, colorIds);
		const resolved2 = ResolvedColorTheme.from(theme2, colorIds);

		assert.strictEqual(resolved1.equals(resolved2), false);
	});

	test('equals() returns true for same instance', () => {
		const theme = new TestColorTheme({
			'editor.background': '#1e1e1e',
		}, ColorScheme.DARK);

		const resolved = ResolvedColorTheme.from(theme, ['editor.background']);

		assert.strictEqual(resolved.equals(resolved), true);
	});

	test('defines() returns true for included colors', () => {
		const theme = new TestColorTheme({
			'editor.background': '#1e1e1e',
		}, ColorScheme.DARK);

		const resolved = ResolvedColorTheme.from(theme, ['editor.background']);

		assert.strictEqual(resolved.defines('editor.background'), true);
		assert.strictEqual(resolved.defines('editor.foreground'), false);
	});

	test('getColor() returns undefined for non-included colors', () => {
		const theme = new TestColorTheme({
			'editor.background': '#1e1e1e',
			'editor.foreground': '#d4d4d4',
		}, ColorScheme.DARK);

		const resolved = ResolvedColorTheme.from(theme, ['editor.background']);

		assert.strictEqual(resolved.getColor('editor.foreground'), undefined);
	});

	test('getColorIds() returns all defined color identifiers', () => {
		const resolved = ResolvedColorTheme.create(
			ColorScheme.DARK,
			'Test',
			{ 'a': '#111', 'b': '#222', 'c': '#333' }
		);

		const ids = [...resolved.getColorIds()];
		assert.deepStrictEqual(ids.sort(), ['a', 'b', 'c']);
	});
});
