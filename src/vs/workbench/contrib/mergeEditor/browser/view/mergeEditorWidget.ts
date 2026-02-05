/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension, reset } from '../../../../../base/browser/dom.js';
import { Grid, GridNodeDescriptor, ISerializableView, SerializableGrid } from '../../../../../base/browser/ui/grid/grid.js';
import { Orientation } from '../../../../../base/browser/ui/splitview/splitview.js';
import { Color } from '../../../../../base/common/color.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { autorunWithStore, IObservable, IReader, ISettableObservable, observableValue, transaction } from '../../../../../base/common/observable.js';
import { isDefined } from '../../../../../base/common/types.js';
import { ICodeEditor, IViewZoneChangeAccessor } from '../../../../../editor/browser/editorBrowser.js';
import { IEditorOptions as ICodeEditorOptions } from '../../../../../editor/common/config/editorOptions.js';
import { ScrollType } from '../../../../../editor/common/editorCommon.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { settingsSashBorder } from '../../../preferences/common/settingsEditorColorRegistry.js';
import { MergeEditorModel } from '../model/mergeEditorModel.js';
import { deepMerge } from '../utils.js';
import { BaseCodeEditorView } from './editors/baseCodeEditorView.js';
import { InputCodeEditorView } from './editors/inputCodeEditorView.js';
import { ResultCodeEditorView } from './editors/resultCodeEditorView.js';
import { ScrollSynchronizer } from './scrollSynchronizer.js';
import { MergeEditorViewModel } from './viewModel.js';
import { ViewZoneComputer } from './viewZones.js';
import { MergeEditorLayoutKind } from '../../common/mergeEditor.js';

export interface IMergeEditorLayout {
	readonly kind: MergeEditorLayoutKind;
	readonly showBase: boolean;
	readonly showBaseAtTop: boolean;
}

export interface MergeEditorWidgetOptions {
	readonly initialLayout?: IMergeEditorLayout;
	readonly showNonConflictingChanges?: boolean;
}

/**
 * The core merge editor widget, decoupled from workbench integration.
 * This widget manages the grid layout with input1, input2, base (optional), and result editors.
 */
export class MergeEditorWidget extends Disposable {
	private readonly _grid = this._register(new MutableDisposable<Grid<ISerializableView>>());
	private readonly _rootElement: HTMLElement;

	public readonly input1View: InputCodeEditorView;
	public readonly input2View: InputCodeEditorView;
	public readonly inputResultView: ResultCodeEditorView;
	private readonly _baseView: ISettableObservable<BaseCodeEditorView | undefined>;
	private readonly _baseViewOptions = observableValue<Readonly<ICodeEditorOptions> | undefined>(this, undefined);
	private readonly _baseViewDisposables = this._register(new DisposableStore());

	private readonly _viewModel: ISettableObservable<MergeEditorViewModel | undefined>;
	public get viewModel(): IObservable<MergeEditorViewModel | undefined> {
		return this._viewModel;
	}

	private readonly _layoutMode: ISettableObservable<IMergeEditorLayout>;
	public get layoutMode(): IObservable<IMergeEditorLayout> {
		return this._layoutMode;
	}

	private readonly _showNonConflictingChanges: ISettableObservable<boolean>;
	public get showNonConflictingChanges(): IObservable<boolean> {
		return this._showNonConflictingChanges;
	}

	private readonly _viewZoneComputer: ViewZoneComputer;
	private readonly _scrollSynchronizer: ScrollSynchronizer;

	private readonly _onDidChangeSizeConstraints = this._register(new Emitter<void>());
	public readonly onDidChangeSizeConstraints: Event<void> = this._onDidChangeSizeConstraints.event;

	private readonly _onDidChangeLayout = this._register(new Emitter<IMergeEditorLayout>());
	public readonly onDidChangeLayout: Event<IMergeEditorLayout> = this._onDidChangeLayout.event;

	constructor(
		parent: HTMLElement,
		options: MergeEditorWidgetOptions | undefined,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IThemeService private readonly _themeService: IThemeService,
	) {
		super();

		this._rootElement = parent;
		this._rootElement.classList.add('merge-editor');

		const initialLayout = options?.initialLayout ?? { kind: 'mixed', showBase: false, showBaseAtTop: true };
		this._layoutMode = observableValue(this, initialLayout);
		this._showNonConflictingChanges = observableValue(this, options?.showNonConflictingChanges ?? false);
		this._viewModel = observableValue<MergeEditorViewModel | undefined>(this, undefined);
		this._baseView = observableValue<BaseCodeEditorView | undefined>(this, undefined);

		// Create the editor views
		this.input1View = this._register(this._instantiationService.createInstance(InputCodeEditorView, 1, this._viewModel));
		this.input2View = this._register(this._instantiationService.createInstance(InputCodeEditorView, 2, this._viewModel));
		this.inputResultView = this._register(this._instantiationService.createInstance(ResultCodeEditorView, this._viewModel));

		this._viewZoneComputer = new ViewZoneComputer(
			this.input1View.editor,
			this.input2View.editor,
			this.inputResultView.editor,
		);

		this._scrollSynchronizer = this._register(new ScrollSynchronizer(
			this._viewModel,
			this.input1View,
			this.input2View,
			this._baseView,
			this.inputResultView,
			this._layoutMode
		));

		// Apply initial layout
		this._applyLayout(initialLayout);
	}

	public get baseView(): IObservable<BaseCodeEditorView | undefined> {
		return this._baseView;
	}

	public get minimumWidth(): number {
		return this._layoutMode.get().kind === 'mixed'
			? this.input1View.view.minimumWidth + this.input2View.view.minimumWidth
			: this.input1View.view.minimumWidth + this.input2View.view.minimumWidth + this.inputResultView.view.minimumWidth;
	}

	/**
	 * Sets the merge editor model and creates the view model.
	 */
	public setModel(model: MergeEditorModel | undefined): MergeEditorViewModel | undefined {
		if (!model) {
			transaction(tx => {
				this._viewModel.set(undefined, tx);
			});
			return undefined;
		}

		const viewModel = this._instantiationService.createInstance(
			MergeEditorViewModel,
			model,
			this.input1View,
			this.input2View,
			this.inputResultView,
			this._baseView,
			this._showNonConflictingChanges,
		);

		transaction(tx => {
			this._viewModel.set(viewModel, tx);
		});

		return viewModel;
	}

	/**
	 * Sets up view zones for alignment. Should be called after setting the model.
	 * Returns a disposable that cleans up the view zones.
	 */
	public setupViewZones(): IDisposable {
		const viewZoneRegistrationStore = new DisposableStore();

		const disposable = autorunWithStore((reader) => {
			/** @description update alignment view zones */
			const viewModel = this._viewModel.read(reader);
			if (!viewModel) {
				return;
			}

			const baseView = this._baseView.read(reader);
			const resultScrollTop = this.inputResultView.editor.getScrollTop();
			this._scrollSynchronizer.stopSync();

			viewZoneRegistrationStore.clear();

			this.inputResultView.editor.changeViewZones(resultViewZoneAccessor => {
				const layout = this._layoutMode.read(reader);
				const shouldAlignResult = layout.kind === 'columns';
				const shouldAlignBase = layout.kind === 'mixed' && !layout.showBaseAtTop;

				this.input1View.editor.changeViewZones(input1ViewZoneAccessor => {
					this.input2View.editor.changeViewZones(input2ViewZoneAccessor => {
						if (baseView) {
							baseView.editor.changeViewZones(baseViewZoneAccessor => {
								viewZoneRegistrationStore.add(this._setViewZones(reader,
									viewModel,
									this.input1View.editor,
									input1ViewZoneAccessor,
									this.input2View.editor,
									input2ViewZoneAccessor,
									baseView.editor,
									baseViewZoneAccessor,
									shouldAlignBase,
									this.inputResultView.editor,
									resultViewZoneAccessor,
									shouldAlignResult
								));
							});
						} else {
							viewZoneRegistrationStore.add(this._setViewZones(reader,
								viewModel,
								this.input1View.editor,
								input1ViewZoneAccessor,
								this.input2View.editor,
								input2ViewZoneAccessor,
								undefined,
								undefined,
								false,
								this.inputResultView.editor,
								resultViewZoneAccessor,
								shouldAlignResult
							));
						}
					});
				});
			});

			this.inputResultView.editor.setScrollTop(resultScrollTop, ScrollType.Smooth);
			this._scrollSynchronizer.startSync();
			this._scrollSynchronizer.updateScrolling();
		});

		return {
			dispose: () => {
				disposable.dispose();
				viewZoneRegistrationStore.dispose();
			}
		};
	}

	private _setViewZones(
		reader: IReader,
		viewModel: MergeEditorViewModel,
		input1Editor: ICodeEditor,
		input1ViewZoneAccessor: IViewZoneChangeAccessor,
		input2Editor: ICodeEditor,
		input2ViewZoneAccessor: IViewZoneChangeAccessor,
		baseEditor: ICodeEditor | undefined,
		baseViewZoneAccessor: IViewZoneChangeAccessor | undefined,
		shouldAlignBase: boolean,
		resultEditor: ICodeEditor,
		resultViewZoneAccessor: IViewZoneChangeAccessor,
		shouldAlignResult: boolean,
	): IDisposable {
		const input1ViewZoneIds: string[] = [];
		const input2ViewZoneIds: string[] = [];
		const baseViewZoneIds: string[] = [];
		const resultViewZoneIds: string[] = [];

		const viewZones = this._viewZoneComputer.computeViewZones(reader, viewModel, {
			codeLensesVisible: true,
			showNonConflictingChanges: this._showNonConflictingChanges.read(reader),
			shouldAlignBase,
			shouldAlignResult,
		});

		const disposableStore = new DisposableStore();

		if (baseViewZoneAccessor) {
			for (const v of viewZones.baseViewZones) {
				v.create(baseViewZoneAccessor, baseViewZoneIds, disposableStore);
			}
		}

		for (const v of viewZones.resultViewZones) {
			v.create(resultViewZoneAccessor, resultViewZoneIds, disposableStore);
		}

		for (const v of viewZones.input1ViewZones) {
			v.create(input1ViewZoneAccessor, input1ViewZoneIds, disposableStore);
		}

		for (const v of viewZones.input2ViewZones) {
			v.create(input2ViewZoneAccessor, input2ViewZoneIds, disposableStore);
		}

		disposableStore.add({
			dispose: () => {
				input1Editor.changeViewZones(a => {
					for (const zone of input1ViewZoneIds) {
						a.removeZone(zone);
					}
				});
				input2Editor.changeViewZones(a => {
					for (const zone of input2ViewZoneIds) {
						a.removeZone(zone);
					}
				});
				baseEditor?.changeViewZones(a => {
					for (const zone of baseViewZoneIds) {
						a.removeZone(zone);
					}
				});
				resultEditor.changeViewZones(a => {
					for (const zone of resultViewZoneIds) {
						a.removeZone(zone);
					}
				});
			}
		});

		return disposableStore;
	}

	/**
	 * Applies editor options to all editors.
	 */
	public applyOptions(options: ICodeEditorOptions): void {
		const inputOptions: ICodeEditorOptions = deepMerge<ICodeEditorOptions>(options, {
			minimap: { enabled: false },
			glyphMargin: false,
			lineNumbersMinChars: 2
		});

		const readOnlyInputOptions: ICodeEditorOptions = deepMerge<ICodeEditorOptions>(inputOptions, {
			readOnly: true,
			readOnlyMessage: undefined
		});

		this.input1View.updateOptions(readOnlyInputOptions);
		this.input2View.updateOptions(readOnlyInputOptions);
		this._baseViewOptions.set({ ...this.input2View.editor.getRawOptions() }, undefined);
		this.inputResultView.updateOptions(inputOptions);
	}

	/**
	 * Layouts the widget to the specified dimensions.
	 */
	public layout(dimension: Dimension): void {
		this._grid.value?.layout(dimension.width, dimension.height);
	}

	/**
	 * Gets the current layout.
	 */
	public getLayout(): IMergeEditorLayout {
		return this._layoutMode.get();
	}

	/**
	 * Sets the layout configuration.
	 */
	public setLayout(newLayout: IMergeEditorLayout): void {
		const currentLayout = this._layoutMode.get();
		if (JSON.stringify(currentLayout) === JSON.stringify(newLayout)) {
			return;
		}
		this._applyLayout(newLayout);
		this._onDidChangeLayout.fire(newLayout);
	}

	/**
	 * Toggles showing the base editor.
	 */
	public toggleBase(): void {
		this.setLayout({
			...this._layoutMode.get(),
			showBase: !this._layoutMode.get().showBase
		});
	}

	/**
	 * Toggles showing the base editor at the top.
	 */
	public toggleShowBaseTop(): void {
		const layout = this._layoutMode.get();
		const showBaseTop = layout.showBase && layout.showBaseAtTop;
		this.setLayout({
			...layout,
			showBaseAtTop: true,
			showBase: !showBaseTop,
		});
	}

	/**
	 * Toggles showing the base editor in the center.
	 */
	public toggleShowBaseCenter(): void {
		const layout = this._layoutMode.get();
		const showBaseCenter = layout.showBase && !layout.showBaseAtTop;
		this.setLayout({
			...layout,
			showBaseAtTop: false,
			showBase: !showBaseCenter,
		});
	}

	/**
	 * Sets the layout kind (mixed or columns).
	 */
	public setLayoutKind(kind: MergeEditorLayoutKind): void {
		this.setLayout({
			...this._layoutMode.get(),
			kind
		});
	}

	/**
	 * Toggles showing non-conflicting changes.
	 */
	public toggleShowNonConflictingChanges(): void {
		this._showNonConflictingChanges.set(!this._showNonConflictingChanges.get(), undefined);
	}

	/**
	 * Sets whether to show non-conflicting changes.
	 */
	public setShowNonConflictingChanges(show: boolean): void {
		this._showNonConflictingChanges.set(show, undefined);
	}

	private _applyLayout(layout: IMergeEditorLayout): void {
		transaction(tx => {
			/** @description applyLayout */

			if (layout.showBase && !this._baseView.get()) {
				this._baseViewDisposables.clear();
				const baseView = this._baseViewDisposables.add(
					this._instantiationService.createInstance(
						BaseCodeEditorView,
						this._viewModel
					)
				);
				this._baseViewDisposables.add(autorunWithStore((reader) => {
					/** @description Update base view options */
					const options = this._baseViewOptions.read(reader);
					if (options) {
						baseView.updateOptions(options);
					}
				}));
				this._baseView.set(baseView, tx);
			} else if (!layout.showBase && this._baseView.get()) {
				this._baseView.set(undefined, tx);
				this._baseViewDisposables.clear();
			}

			if (layout.kind === 'mixed') {
				this._setGrid([
					layout.showBaseAtTop && layout.showBase ? {
						size: 38,
						data: this._baseView.get()!.view
					} : undefined,
					{
						size: 38,
						groups: [
							{ data: this.input1View.view },
							!layout.showBaseAtTop && layout.showBase ? { data: this._baseView.get()!.view } : undefined,
							{ data: this.input2View.view }
						].filter(isDefined)
					},
					{
						size: 62,
						data: this.inputResultView.view
					},
				].filter(isDefined));
			} else if (layout.kind === 'columns') {
				this._setGrid([
					layout.showBase ? {
						size: 40,
						data: this._baseView.get()!.view
					} : undefined,
					{
						size: 60,
						groups: [{ data: this.input1View.view }, { data: this.inputResultView.view }, { data: this.input2View.view }]
					},
				].filter(isDefined));
			}

			this._layoutMode.set(layout, tx);
			this._onDidChangeSizeConstraints.fire();
		});
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private _setGrid(descriptor: GridNodeDescriptor<any>[]): void {
		let width = -1;
		let height = -1;
		if (this._grid.value) {
			width = this._grid.value.width;
			height = this._grid.value.height;
		}

		const theme = this._themeService.getColorTheme();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		this._grid.value = SerializableGrid.from<any>({
			orientation: Orientation.VERTICAL,
			size: 100,
			groups: descriptor,
		}, {
			styles: { separatorBorder: theme.getColor(settingsSashBorder) ?? Color.transparent },
			proportionalLayout: true
		});

		reset(this._rootElement, this._grid.value.element);
		// Only call layout after the elements have been added to the DOM,
		// so that they have a defined size.
		if (width !== -1) {
			this._grid.value.layout(width, height);
		}
	}

	/**
	 * Gets the result editor (the main control for the merge editor).
	 */
	public getResultEditor(): ICodeEditor {
		return this.inputResultView.editor;
	}

	/**
	 * Checks if any of the editors has focus.
	 */
	public hasFocus(): boolean {
		for (const { editor } of [this.input1View, this.input2View, this.inputResultView]) {
			if (editor.hasTextFocus()) {
				return true;
			}
		}
		const baseView = this._baseView.get();
		if (baseView?.editor.hasTextFocus()) {
			return true;
		}
		return false;
	}

	/**
	 * Sets visibility state for all editors.
	 */
	public setVisible(visible: boolean): void {
		for (const { editor } of [this.input1View, this.input2View, this.inputResultView]) {
			if (visible) {
				editor.onVisible();
			} else {
				editor.onHide();
			}
		}
		const baseView = this._baseView.get();
		if (baseView) {
			if (visible) {
				baseView.editor.onVisible();
			} else {
				baseView.editor.onHide();
			}
		}
	}

	/**
	 * Clears all editor models.
	 */
	public clearModels(): void {
		transaction(tx => {
			this._viewModel.set(undefined, tx);
		});
		for (const { editor } of [this.input1View, this.input2View, this.inputResultView]) {
			editor.setModel(null);
		}
		const baseView = this._baseView.get();
		if (baseView) {
			baseView.editor.setModel(null);
		}
	}
}
