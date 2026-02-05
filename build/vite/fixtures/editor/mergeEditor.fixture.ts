/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../src/vs/base/browser/dom';
import { toDisposable } from '../../../../src/vs/base/common/lifecycle';
import { IReader } from '../../../../src/vs/base/common/observable';
import { isDefined } from '../../../../src/vs/base/common/types';
import { URI } from '../../../../src/vs/base/common/uri';
import { ITextModel } from '../../../../src/vs/editor/common/model';
import { linesDiffComputers } from '../../../../src/vs/editor/common/diff/linesDiffComputers';
import { NullTelemetryService } from '../../../../src/vs/platform/telemetry/common/telemetryUtils';
import { MergeEditorWidget } from '../../../../src/vs/workbench/contrib/mergeEditor/browser/view/mergeEditorWidget';
import { MergeEditorModel } from '../../../../src/vs/workbench/contrib/mergeEditor/browser/model/mergeEditorModel';
import { MergeEditorTelemetry } from '../../../../src/vs/workbench/contrib/mergeEditor/browser/telemetry';
import { IMergeDiffComputer, IMergeDiffComputerResult, toLineRange, toRangeMapping } from '../../../../src/vs/workbench/contrib/mergeEditor/browser/model/diffComputer';
import { DetailedLineRangeMapping } from '../../../../src/vs/workbench/contrib/mergeEditor/browser/model/mapping';
import { ComponentFixtureContext, createEditorServices, createTextModel, defineComponentFixture, defineThemedFixtureGroup, registerWorkbenchServices } from '../fixtureUtils';

// Required CSS
import '../../../../src/vs/workbench/contrib/mergeEditor/browser/view/media/mergeEditor.css';


// ============================================================================
// Sample Conflict Content
// ============================================================================

const BASE_CONTENT = `function greet(name: string) {
	console.log('Hello, ' + name);
}

function calculate(a: number, b: number) {
	return a + b;
}

export { greet, calculate };
`;

const INPUT1_CONTENT = `function greet(name: string) {
	console.log(\`Hello, \${name}!\`);
}

function calculate(a: number, b: number) {
	// Added validation
	if (typeof a !== 'number' || typeof b !== 'number') {
		throw new Error('Invalid arguments');
	}
	return a + b;
}

export { greet, calculate };
`;

const INPUT2_CONTENT = `function greet(name: string, greeting = 'Hello') {
	console.log(greeting + ', ' + name);
}

function calculate(a: number, b: number) {
	return a + b;
}

function multiply(a: number, b: number) {
	return a * b;
}

export { greet, calculate, multiply };
`;

const RESULT_CONTENT = `function greet(name: string) {
	console.log('Hello, ' + name);
}

function calculate(a: number, b: number) {
	return a + b;
}

export { greet, calculate };
`;


// ============================================================================
// Diff Computer
// ============================================================================

function createDiffComputer(): IMergeDiffComputer {
	return {
		async computeDiff(textModel1: ITextModel, textModel2: ITextModel, _reader: IReader): Promise<IMergeDiffComputerResult> {
			const result = await linesDiffComputers.getLegacy().computeDiff(
				textModel1.getLinesContent(),
				textModel2.getLinesContent(),
				{ ignoreTrimWhitespace: false, maxComputationTimeMs: 10000, computeMoves: false }
			);
			const changes = result.changes.map(c =>
				new DetailedLineRangeMapping(
					toLineRange(c.original),
					textModel1,
					toLineRange(c.modified),
					textModel2,
					c.innerChanges?.map(ic => toRangeMapping(ic)).filter(isDefined)
				)
			);
			return { diffs: changes };
		}
	};
}


// ============================================================================
// Renderer
// ============================================================================

interface RenderMergeEditorOptions extends ComponentFixtureContext {
	showBase?: boolean;
}

async function renderMergeEditor(options: RenderMergeEditorOptions): Promise<HTMLElement> {
	const { container, disposableStore, theme, showBase = false } = options;

	const width = 1200;
	const height = showBase ? 700 : 600;

	// Container setup - monaco-workbench must be ancestor of .merge-editor
	container.style.width = `${width}px`;
	container.style.height = `${height}px`;
	container.style.border = '1px solid var(--vscode-editorWidget-border)';
	container.style.position = 'relative';
	container.classList.add('monaco-workbench');

	const widgetContainer = document.createElement('div');
	widgetContainer.style.width = '100%';
	widgetContainer.style.height = '100%';
	container.appendChild(widgetContainer);

	// Services
	const instantiationService = createEditorServices(disposableStore, {
		colorTheme: theme,
		additionalServices: registerWorkbenchServices
	});

	// Text models
	const baseModel = disposableStore.add(createTextModel(instantiationService, BASE_CONTENT, URI.parse('inmemory://base.ts'), 'typescript'));
	const input1Model = disposableStore.add(createTextModel(instantiationService, INPUT1_CONTENT, URI.parse('inmemory://input1.ts'), 'typescript'));
	const input2Model = disposableStore.add(createTextModel(instantiationService, INPUT2_CONTENT, URI.parse('inmemory://input2.ts'), 'typescript'));
	const resultModel = disposableStore.add(createTextModel(instantiationService, RESULT_CONTENT, URI.parse('inmemory://result.ts'), 'typescript'));

	// Merge model
	const mergeModel = disposableStore.add(instantiationService.createInstance(
		MergeEditorModel,
		baseModel,
		{ textModel: input1Model, title: 'Ours', description: 'feature-branch', detail: 'Local changes' },
		{ textModel: input2Model, title: 'Theirs', description: 'main', detail: 'Remote changes' },
		resultModel,
		createDiffComputer(),
		{ resetResult: false },
		new MergeEditorTelemetry(NullTelemetryService),
	));
	await mergeModel.onInitialized;

	// Widget
	const widget = disposableStore.add(instantiationService.createInstance(
		MergeEditorWidget,
		widgetContainer,
		{
			initialLayout: { kind: 'mixed', showBase, showBaseAtTop: true },
			showNonConflictingChanges: true,
		}
	));

	const viewModel = widget.setModel(mergeModel);
	if (viewModel) {
		disposableStore.add(viewModel);
	}

	disposableStore.add(widget.setupViewZones());
	widget.layout(new Dimension(width, height));

	// Resize handling
	const resizeObserver = new ResizeObserver(entries => {
		for (const entry of entries) {
			if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
				widget.layout(new Dimension(entry.contentRect.width, entry.contentRect.height));
			}
		}
	});
	resizeObserver.observe(container);
	disposableStore.add(toDisposable(() => resizeObserver.disconnect()));

	return container;
}


// ============================================================================
// Fixtures
// ============================================================================

export default defineThemedFixtureGroup({
	MergeEditor: defineComponentFixture({
		render: (context) => renderMergeEditor(context),
	}),

	MergeEditorWithBase: defineComponentFixture({
		render: (context) => renderMergeEditor({ ...context, showBase: true }),
	}),
});
