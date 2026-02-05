/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { constObservable, IObservable, IReader } from '../../../base/common/observable.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IUserInteractionService = createDecorator<IUserInteractionService>('userInteractionService');

export interface IModifierKeyStatus {
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
}

export interface IUserInteractionService {
	readonly _serviceBrand: undefined;

	/**
	 * Reads the current modifier key status for the window containing the given element.
	 * Pass an element to determine the correct window context (for multi-window support).
	 */
	readModifierKeyStatus(element: HTMLElement | Window, reader: IReader | undefined): IModifierKeyStatus;

	/**
	 * Creates an observable that tracks whether the given element (or a descendant) has focus.
	 * The observable is disposed when the disposable store is disposed.
	 */
	createFocusTracker(element: HTMLElement | Window, store: DisposableStore): IObservable<boolean>;

	/**
	 * Creates an observable that tracks whether the given element is hovered.
	 * The observable is disposed when the disposable store is disposed.
	 */
	createHoverTracker(element: HTMLElement, store: DisposableStore): IObservable<boolean>;
}

/**
 * Mock implementation of IUserInteractionService that can be used for testing
 * or simulating specific interaction states.
 */
export class MockUserInteractionService implements IUserInteractionService {
	readonly _serviceBrand: undefined;

	constructor(
		private readonly _simulateFocus: boolean = true,
		private readonly _simulateHover: boolean = false,
		private readonly _modifiers: IModifierKeyStatus = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }
	) { }

	readModifierKeyStatus(_element: HTMLElement | Window, _reader: IReader | undefined): IModifierKeyStatus {
		return this._modifiers;
	}

	createFocusTracker(_element: HTMLElement | Window, _store: DisposableStore): IObservable<boolean> {
		return constObservable(this._simulateFocus);
	}

	createHoverTracker(_element: HTMLElement, _store: DisposableStore): IObservable<boolean> {
		return constObservable(this._simulateHover);
	}
}
