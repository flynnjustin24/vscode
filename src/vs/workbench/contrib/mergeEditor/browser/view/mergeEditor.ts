/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { BugIndicatingError, onUnexpectedError } from '../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, thenIfNotDisposed, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, IObservable, observableValue, transaction } from '../../../../../base/common/observable.js';
import { basename, isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import './media/mergeEditor.css';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { IEditorOptions as ICodeEditorOptions } from '../../../../../editor/common/config/editorOptions.js';
import { ICodeEditorViewState, ScrollType } from '../../../../../editor/common/editorCommon.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ITextResourceConfigurationService } from '../../../../../editor/common/services/textResourceConfiguration.js';
import { localize } from '../../../../../nls.js';
import { IContextKey, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IEditorOptions, ITextEditorOptions, ITextResourceEditorInput } from '../../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { AbstractTextEditor } from '../../../../browser/parts/editor/textEditor.js';
import { DEFAULT_EDITOR_ASSOCIATION, EditorInputWithOptions, IEditorOpenContext, IResourceMergeEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { applyTextEditorOptions } from '../../../../common/editor/editorOptions.js';
import { readTransientState, writeTransientState } from '../../../codeEditor/browser/toggleWordWrap.js';
import { MergeEditorInput } from '../mergeEditorInput.js';
import { IMergeEditorInputModel } from '../mergeEditorInputModel.js';
import { PersistentStore } from '../utils.js';
import { MergeEditorViewModel } from './viewModel.js';
import { ctxIsMergeEditor, ctxMergeBaseUri, ctxMergeEditorLayout, ctxMergeEditorShowBase, ctxMergeEditorShowBaseAtTop, ctxMergeEditorShowNonConflictingChanges, ctxMergeResultUri, MergeEditorLayoutKind } from '../../common/mergeEditor.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorResolverService, MergeEditorInputFactoryFunction, RegisteredEditorPriority } from '../../../../services/editor/common/editorResolverService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import './colors.js';
import { MergeEditorWidget, type IMergeEditorLayout } from './mergeEditorWidget.js';

export type { IMergeEditorLayout };

export class MergeEditor extends AbstractTextEditor<IMergeEditorViewState> {

	static readonly ID = 'mergeEditor';

	private readonly _sessionDisposables = new DisposableStore();

	private _widget: MergeEditorWidget | undefined;
	private get widget(): MergeEditorWidget {
		if (!this._widget) {
			throw new BugIndicatingError('MergeEditorWidget not initialized');
		}
		return this._widget;
	}

	public get viewModel(): IObservable<MergeEditorViewModel | undefined> {
		return this._widget?.viewModel ?? observableValue(this, undefined);
	}

	private readonly _inputModel = observableValue<IMergeEditorInputModel | undefined>(this, undefined);
	public get inputModel(): IObservable<IMergeEditorInputModel | undefined> {
		return this._inputModel;
	}

	public get model() {
		return this.inputModel.get()?.model;
	}

	private readonly _layoutMode: MergeEditorLayoutStore;
	private readonly _ctxIsMergeEditor: IContextKey<boolean>;
	private readonly _ctxUsesColumnLayout: IContextKey<string>;
	private readonly _ctxShowBase: IContextKey<boolean>;
	private readonly _ctxShowBaseAtTop: IContextKey<boolean>;
	private readonly _ctxResultUri: IContextKey<string>;
	private readonly _ctxBaseUri: IContextKey<string>;
	private readonly _ctxShowNonConflictingChanges: IContextKey<boolean>;

	private readonly _showNonConflictingChangesStore: PersistentStore<boolean>;

	constructor(
		group: IEditorGroup,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IStorageService storageService: IStorageService,
		@IThemeService themeService: IThemeService,
		@ITextResourceConfigurationService textResourceConfigurationService: ITextResourceConfigurationService,
		@IEditorService editorService: IEditorService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IFileService fileService: IFileService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService
	) {
		super(MergeEditor.ID, group, telemetryService, instantiation, storageService, textResourceConfigurationService, themeService, editorService, editorGroupService, fileService);
		this._layoutMode = this.instantiationService.createInstance(MergeEditorLayoutStore);
		this._ctxIsMergeEditor = ctxIsMergeEditor.bindTo(this.contextKeyService);
		this._ctxUsesColumnLayout = ctxMergeEditorLayout.bindTo(this.contextKeyService);
		this._ctxShowBase = ctxMergeEditorShowBase.bindTo(this.contextKeyService);
		this._ctxShowBaseAtTop = ctxMergeEditorShowBaseAtTop.bindTo(this.contextKeyService);
		this._ctxResultUri = ctxMergeResultUri.bindTo(this.contextKeyService);
		this._ctxBaseUri = ctxMergeBaseUri.bindTo(this.contextKeyService);
		this._ctxShowNonConflictingChanges = ctxMergeEditorShowNonConflictingChanges.bindTo(this.contextKeyService);
		this._showNonConflictingChangesStore = this.instantiationService.createInstance(PersistentStore<boolean>, 'mergeEditor/showNonConflictingChanges');
	}

	override dispose(): void {
		this._sessionDisposables.dispose();
		this._ctxIsMergeEditor.reset();
		this._ctxUsesColumnLayout.reset();
		this._ctxShowNonConflictingChanges.reset();
		super.dispose();
	}

	// #region layout constraints

	private readonly _onDidChangeSizeConstraints = this._register(new Emitter<void>());
	override readonly onDidChangeSizeConstraints: Event<void> = this._onDidChangeSizeConstraints.event;

	override get minimumWidth() {
		return this._widget?.minimumWidth ?? 0;
	}

	// #endregion

	override getTitle(): string {
		if (this.input) {
			return this.input.getName();
		}

		return localize('mergeEditor', "Text Merge Editor");
	}

	protected createEditorControl(parent: HTMLElement, initialOptions: ICodeEditorOptions): void {
		const showNonConflictingChanges = this._showNonConflictingChangesStore.get() ?? false;
		this._widget = this._register(this.instantiationService.createInstance(
			MergeEditorWidget,
			parent,
			{
				initialLayout: this._layoutMode.value,
				showNonConflictingChanges,
			}
		));

		this._register(this._widget.onDidChangeSizeConstraints(() => this._onDidChangeSizeConstraints.fire()));
		this._register(this._widget.onDidChangeLayout(layout => {
			this._layoutMode.value = layout;
			this._ctxUsesColumnLayout.set(layout.kind);
			this._ctxShowBase.set(layout.showBase);
			this._ctxShowBaseAtTop.set(layout.showBaseAtTop);
		}));

		this._widget.applyOptions(initialOptions);
	}

	protected updateEditorControlOptions(options: ICodeEditorOptions): void {
		this._widget?.applyOptions(options);
	}

	protected getMainControl(): ICodeEditor | undefined {
		return this._widget?.getResultEditor();
	}

	layout(dimension: Dimension): void {
		this._widget?.layout(dimension);
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		if (!(input instanceof MergeEditorInput)) {
			throw new BugIndicatingError('ONLY MergeEditorInput is supported');
		}
		await super.setInput(input, options, context, token);

		this._sessionDisposables.clear();
		this.widget.setModel(undefined);
		transaction(tx => {
			this._inputModel.set(undefined, tx);
		});

		const inputModel = await input.resolve();
		const model = inputModel.model;

		const viewModel = this.widget.setModel(model);
		if (!viewModel) {
			return;
		}

		const layout = this.widget.getLayout();
		model.telemetry.reportMergeEditorOpened({
			combinableConflictCount: model.combinableConflictCount,
			conflictCount: model.conflictCount,
			baseTop: layout.showBaseAtTop,
			baseVisible: layout.showBase,
			isColumnView: layout.kind === 'columns',
		});

		transaction(tx => {
			this._inputModel.set(inputModel, tx);
		});
		this._sessionDisposables.add(viewModel);

		// Track focus changes to update the editor name
		this._sessionDisposables.add(autorun(reader => {
			/** @description Update focused editor name based on focus */
			const focusedType = viewModel.focusedEditorType.read(reader);

			if (!(input instanceof MergeEditorInput)) {
				return;
			}

			input.updateFocusedEditor(focusedType || 'result');
		}));

		// Set/unset context keys based on input
		this._ctxResultUri.set(inputModel.resultUri.toString());
		this._ctxBaseUri.set(model.base.uri.toString());
		this._sessionDisposables.add(toDisposable(() => {
			this._ctxBaseUri.reset();
			this._ctxResultUri.reset();
		}));

		// Set the view zones before restoring view state!
		// Otherwise scrolling will be off
		this._sessionDisposables.add(this.widget.setupViewZones());

		const viewState = this.loadEditorViewState(input, context);
		if (viewState) {
			this._applyViewState(viewState);
		} else {
			this._sessionDisposables.add(thenIfNotDisposed(model.onInitialized, () => {
				const firstConflict = model.modifiedBaseRanges.get().find(r => r.isConflicting);
				if (!firstConflict) {
					return;
				}
				this.widget.input1View.editor.revealLineInCenter(firstConflict.input1Range.startLineNumber);
				transaction(tx => {
					/** @description setActiveModifiedBaseRange */
					viewModel.setActiveModifiedBaseRange(firstConflict, tx);
				});
			}));
		}

		// word wrap special case - sync transient state from result model to input[1|2] models
		const mirrorWordWrapTransientState = (candidate: ITextModel) => {
			const candidateState = readTransientState(candidate, this._codeEditorService);

			writeTransientState(model.input2.textModel, candidateState, this._codeEditorService);
			writeTransientState(model.input1.textModel, candidateState, this._codeEditorService);
			writeTransientState(model.resultTextModel, candidateState, this._codeEditorService);

			const baseTextModel = this.widget.baseView.get()?.editor.getModel();
			if (baseTextModel) {
				writeTransientState(baseTextModel, candidateState, this._codeEditorService);
			}
		};
		this._sessionDisposables.add(this._codeEditorService.onDidChangeTransientModelProperty(candidate => {
			mirrorWordWrapTransientState(candidate);
		}));
		mirrorWordWrapTransientState(this.widget.inputResultView.editor.getModel()!);

		// detect when base, input1, and input2 become empty and replace THIS editor with its result editor
		// TODO@jrieken@hediet this needs a better/cleaner solution
		// https://github.com/microsoft/vscode/issues/155940
		const that = this;
		this._sessionDisposables.add(new class {

			private readonly _disposable = new DisposableStore();

			constructor() {
				for (const textModel of this.baseInput1Input2()) {
					this._disposable.add(textModel.onDidChangeContent(() => this._checkBaseInput1Input2AllEmpty()));
				}
			}

			dispose() {
				this._disposable.dispose();
			}

			private *baseInput1Input2() {
				yield model.base;
				yield model.input1.textModel;
				yield model.input2.textModel;
			}

			private _checkBaseInput1Input2AllEmpty() {
				for (const textModel of this.baseInput1Input2()) {
					if (textModel.getValueLength() > 0) {
						return;
					}
				}
				// all empty -> replace this editor with a normal editor for result
				that.editorService.replaceEditors(
					[{ editor: input, replacement: { resource: input.result, options: { preserveFocus: true } }, forceReplaceDirty: true }],
					that.group
				);
			}
		});
	}

	override setOptions(options: ITextEditorOptions | undefined): void {
		super.setOptions(options);

		if (options && this._widget) {
			applyTextEditorOptions(options, this._widget.getResultEditor(), ScrollType.Smooth);
		}
	}

	override clearInput(): void {
		super.clearInput();

		this._sessionDisposables.clear();
		this._widget?.clearModels();
	}

	override focus(): void {
		super.focus();

		(this.getControl() ?? this._widget?.getResultEditor())?.focus();
	}

	override hasFocus(): boolean {
		return this._widget?.hasFocus() ?? super.hasFocus();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);

		this._widget?.setVisible(visible);
		this._ctxIsMergeEditor.set(visible);
	}

	// ---- interact with "outside world" via`getControl`, `scopedContextKeyService`: we only expose the result-editor keep the others internal

	override getControl(): ICodeEditor | undefined {
		return this._widget?.getResultEditor();
	}

	override get scopedContextKeyService(): IContextKeyService | undefined {
		const control = this.getControl();
		return control?.invokeWithinContext(accessor => accessor.get(IContextKeyService));
	}

	// --- layout

	public toggleBase(): void {
		this._widget?.toggleBase();
		this.model?.telemetry.reportLayoutChange({
			baseTop: this._layoutMode.value.showBaseAtTop,
			baseVisible: this._layoutMode.value.showBase,
			isColumnView: this._layoutMode.value.kind === 'columns',
		});
	}

	public toggleShowBaseTop(): void {
		this._widget?.toggleShowBaseTop();
		this.model?.telemetry.reportLayoutChange({
			baseTop: this._layoutMode.value.showBaseAtTop,
			baseVisible: this._layoutMode.value.showBase,
			isColumnView: this._layoutMode.value.kind === 'columns',
		});
	}

	public toggleShowBaseCenter(): void {
		this._widget?.toggleShowBaseCenter();
		this.model?.telemetry.reportLayoutChange({
			baseTop: this._layoutMode.value.showBaseAtTop,
			baseVisible: this._layoutMode.value.showBase,
			isColumnView: this._layoutMode.value.kind === 'columns',
		});
	}

	public setLayoutKind(kind: MergeEditorLayoutKind): void {
		this._widget?.setLayoutKind(kind);
		this.model?.telemetry.reportLayoutChange({
			baseTop: this._layoutMode.value.showBaseAtTop,
			baseVisible: this._layoutMode.value.showBase,
			isColumnView: this._layoutMode.value.kind === 'columns',
		});
	}

	public setLayout(newLayout: IMergeEditorLayout): void {
		this._widget?.setLayout(newLayout);
		this.model?.telemetry.reportLayoutChange({
			baseTop: newLayout.showBaseAtTop,
			baseVisible: newLayout.showBase,
			isColumnView: newLayout.kind === 'columns',
		});
	}

	private _applyViewState(state: IMergeEditorViewState | undefined) {
		if (!state || !this._widget) {
			return;
		}
		this._widget.inputResultView.editor.restoreViewState(state);
		if (state.input1State) {
			this._widget.input1View.editor.restoreViewState(state.input1State);
		}
		if (state.input2State) {
			this._widget.input2View.editor.restoreViewState(state.input2State);
		}
		if (state.focusIndex >= 0) {
			[this._widget.input1View.editor, this._widget.input2View.editor, this._widget.inputResultView.editor][state.focusIndex].focus();
		}
	}

	protected computeEditorViewState(resource: URI): IMergeEditorViewState | undefined {
		if (!isEqual(this.inputModel.get()?.resultUri, resource) || !this._widget) {
			return undefined;
		}
		const result = this._widget.inputResultView.editor.saveViewState();
		if (!result) {
			return undefined;
		}
		const input1State = this._widget.input1View.editor.saveViewState() ?? undefined;
		const input2State = this._widget.input2View.editor.saveViewState() ?? undefined;
		const focusIndex = [this._widget.input1View.editor, this._widget.input2View.editor, this._widget.inputResultView.editor].findIndex(editor => editor.hasWidgetFocus());
		return { ...result, input1State, input2State, focusIndex };
	}


	protected tracksEditorViewState(input: EditorInput): boolean {
		return input instanceof MergeEditorInput;
	}

	public toggleShowNonConflictingChanges(): void {
		this._widget?.toggleShowNonConflictingChanges();
		this._showNonConflictingChangesStore.set(this._widget?.showNonConflictingChanges.get() ?? false);
		this._ctxShowNonConflictingChanges.set(this._widget?.showNonConflictingChanges.get() ?? false);
	}
}

// TODO use PersistentStore
class MergeEditorLayoutStore {
	private static readonly _key = 'mergeEditor/layout';
	private _value: IMergeEditorLayout = { kind: 'mixed', showBase: false, showBaseAtTop: true };

	constructor(@IStorageService private _storageService: IStorageService) {
		const value = _storageService.get(MergeEditorLayoutStore._key, StorageScope.PROFILE, 'mixed');

		if (value === 'mixed' || value === 'columns') {
			this._value = { kind: value, showBase: false, showBaseAtTop: true };
		} else if (value) {
			try {
				this._value = JSON.parse(value);
			} catch (e) {
				onUnexpectedError(e);
			}
		}
	}

	get value() {
		return this._value;
	}

	set value(value: IMergeEditorLayout) {
		if (this._value !== value) {
			this._value = value;
			this._storageService.store(MergeEditorLayoutStore._key, JSON.stringify(this._value), StorageScope.PROFILE, StorageTarget.USER);
		}
	}
}

export class MergeEditorOpenHandlerContribution extends Disposable {

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@ICodeEditorService codeEditorService: ICodeEditorService,
	) {
		super();
		this._store.add(codeEditorService.registerCodeEditorOpenHandler(this.openCodeEditorFromMergeEditor.bind(this)));
	}

	private async openCodeEditorFromMergeEditor(input: ITextResourceEditorInput, _source: ICodeEditor | null, sideBySide?: boolean | undefined): Promise<ICodeEditor | null> {
		const activePane = this._editorService.activeEditorPane;
		if (!sideBySide
			&& input.options
			&& activePane instanceof MergeEditor
			&& activePane.getControl()
			&& activePane.input instanceof MergeEditorInput
			&& isEqual(input.resource, activePane.input.result)
		) {
			// Special: stay inside the merge editor when it is active and when the input
			// targets the result editor of the merge editor.
			const targetEditor = <ICodeEditor>activePane.getControl()!;
			applyTextEditorOptions(input.options, targetEditor, ScrollType.Smooth);
			return targetEditor;
		}

		// cannot handle this
		return null;
	}
}

export class MergeEditorResolverContribution extends Disposable {

	static readonly ID = 'workbench.contrib.mergeEditorResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		const mergeEditorInputFactory: MergeEditorInputFactoryFunction = (mergeEditor: IResourceMergeEditorInput): EditorInputWithOptions => {
			return {
				editor: instantiationService.createInstance(
					MergeEditorInput,
					mergeEditor.base.resource,
					{
						uri: mergeEditor.input1.resource,
						title: mergeEditor.input1.label ?? basename(mergeEditor.input1.resource),
						description: mergeEditor.input1.description ?? '',
						detail: mergeEditor.input1.detail
					},
					{
						uri: mergeEditor.input2.resource,
						title: mergeEditor.input2.label ?? basename(mergeEditor.input2.resource),
						description: mergeEditor.input2.description ?? '',
						detail: mergeEditor.input2.detail
					},
					mergeEditor.result.resource
				)
			};
		};

		this._register(editorResolverService.registerEditor(
			`*`,
			{
				id: DEFAULT_EDITOR_ASSOCIATION.id,
				label: DEFAULT_EDITOR_ASSOCIATION.displayName,
				detail: DEFAULT_EDITOR_ASSOCIATION.providerDisplayName,
				priority: RegisteredEditorPriority.builtin
			},
			{},
			{
				createMergeEditorInput: mergeEditorInputFactory
			}
		));
	}
}

type IMergeEditorViewState = ICodeEditorViewState & {
	readonly input1State?: ICodeEditorViewState;
	readonly input2State?: ICodeEditorViewState;
	readonly focusIndex: number;
};
