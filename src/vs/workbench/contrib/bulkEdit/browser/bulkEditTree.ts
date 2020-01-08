/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAsyncDataSource, ITreeRenderer, ITreeNode } from 'vs/base/browser/ui/tree/tree';
import * as modes from 'vs/editor/common/modes';
import { ITextModelService } from 'vs/editor/common/services/resolverService';
import { FuzzyScore, createMatches } from 'vs/base/common/filters';
import { IResourceLabel, ResourceLabels, DEFAULT_LABELS_CONTAINER } from 'vs/workbench/browser/labels';
import { URI } from 'vs/base/common/uri';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { HighlightedLabel, IHighlight } from 'vs/base/browser/ui/highlightedlabel/highlightedLabel';
import { IIdentityProvider, IListVirtualDelegate } from 'vs/base/browser/ui/list/list';
import { Range } from 'vs/editor/common/core/range';
import * as dom from 'vs/base/browser/dom';
import { ITextModel } from 'vs/editor/common/model';
import { IDisposable } from 'vs/base/common/lifecycle';
import { TextModel } from 'vs/editor/common/model/textModel';
import { ILabelService } from 'vs/platform/label/common/label';
import { BulkFileOperations, BulkFileOperation, BulkFileOperationType } from 'vs/workbench/contrib/bulkEdit/browser/bulkEditPreview';
import { localize } from 'vs/nls';

// --- VIEW MODEL

export class FileElement {

	private static _typeLabels: Record<number, string> = {
		[BulkFileOperationType.Create]: localize('create', "create"),
		[BulkFileOperationType.Delete]: localize('delete', "delete"),
		[BulkFileOperationType.Rename]: localize('rename', "rename"),
		[BulkFileOperationType.Create | BulkFileOperationType.Delete]: localize('createDelete', "create & delete"),
		[BulkFileOperationType.Create | BulkFileOperationType.Rename]: localize('createRename', "create & rename"),
		[BulkFileOperationType.Delete | BulkFileOperationType.Rename]: localize('deleteRename', "delete & rename"),
		[BulkFileOperationType.Create | BulkFileOperationType.Delete | BulkFileOperationType.Rename]: localize('createRenameDelete', "create, rename, delete"),
	};

	readonly uri: URI;
	readonly typeLabel: string;

	constructor(readonly edit: BulkFileOperation) {
		this.uri = edit.uri;
		this.typeLabel = FileElement._typeLabels[edit.type] || '';
	}

}

export class TextEditElement {

	constructor(
		readonly parent: FileElement,
		readonly edit: modes.TextEdit,
		readonly prefix: string, readonly selecting: string, readonly inserting: string, readonly suffix: string
	) { }
}

export type BulkEditElement = FileElement | TextEditElement;

// --- DATA SOURCE

export class BulkEditDataSource implements IAsyncDataSource<BulkFileOperations, BulkEditElement> {

	constructor(@ITextModelService private readonly _textModelService: ITextModelService) { }

	hasChildren(element: BulkFileOperations | BulkEditElement): boolean {
		if (element instanceof FileElement) {
			return element.edit.textEdits.length > 0;
		}
		if (element instanceof TextEditElement) {
			return false;
		}
		return true;
	}

	async getChildren(element: BulkFileOperations | BulkEditElement): Promise<BulkEditElement[]> {

		// root -> file/text edits
		if (element instanceof BulkFileOperations) {
			return element.fileOperations.map(op => new FileElement(op));
		}

		// file: text edit
		if (element instanceof FileElement && element.edit.textEdits.length > 0) {
			// const previewUri = BulkEditPreviewProvider.asPreviewUri(element.edit.resource);
			let textModel: ITextModel;
			let textModelDisposable: IDisposable;
			try {
				const ref = await this._textModelService.createModelReference(element.edit.uri);
				textModel = ref.object.textEditorModel;
				textModelDisposable = ref;
			} catch {
				textModel = TextModel.createFromString('');
				textModelDisposable = textModel;
			}

			const result = element.edit.textEdits.map(edit => {
				const range = Range.lift(edit.range);

				const tokens = textModel.getLineTokens(range.endLineNumber);
				let suffixLen = 0;
				for (let idx = tokens.findTokenIndexAtOffset(range.endColumn); suffixLen < 50 && idx < tokens.getCount(); idx++) {
					suffixLen += tokens.getEndOffset(idx) - tokens.getStartOffset(idx);
				}

				return new TextEditElement(
					element,
					edit,
					textModel.getValueInRange(new Range(range.startLineNumber, 1, range.startLineNumber, range.startColumn)), // line start to edit start,
					textModel.getValueInRange(range),
					edit.text,
					textModel.getValueInRange(new Range(range.endLineNumber, range.endColumn, range.endLineNumber, range.endColumn + suffixLen))
				);
			});

			textModelDisposable.dispose();
			return result;
		}

		return [];
	}
}

// --- IDENT

export class BulkEditIdentityProvider implements IIdentityProvider<BulkEditElement> {

	getId(element: BulkEditElement): { toString(): string; } {
		if (element instanceof FileElement) {
			return element.uri;
		} else {
			return element.parent.uri.toString() + JSON.stringify(element.edit);
		}
	}
}

// --- RENDERER

class FileElementTemplate {
	constructor(readonly label: IResourceLabel) { }
}

export class FileElementRenderer implements ITreeRenderer<FileElement, FuzzyScore, FileElementTemplate> {

	static readonly id: string = 'FileElementRenderer';

	readonly templateId: string = FileElementRenderer.id;

	private readonly _resourceLabels: ResourceLabels;

	constructor(
		@IInstantiationService instaService: IInstantiationService,
		@ILabelService private readonly _labelService: ILabelService,
	) {
		this._resourceLabels = instaService.createInstance(ResourceLabels, DEFAULT_LABELS_CONTAINER);
	}

	dispose(): void {
		this._resourceLabels.dispose();
	}

	renderTemplate(container: HTMLElement): FileElementTemplate {
		return new FileElementTemplate(this._resourceLabels.create(container, { supportHighlights: true }));
	}

	renderElement(node: ITreeNode<FileElement, FuzzyScore>, _index: number, template: FileElementTemplate): void {

		template.label.setResource({
			name: this._labelService.getUriLabel(node.element.uri, { relative: true }),
			description: node.element.typeLabel,
			resource: node.element.uri,
		}, {
			matches: createMatches(node.filterData),
		});
	}

	disposeTemplate(template: FileElementTemplate): void {
		template.label.dispose();
	}
}

class TextEditElementTemplate {
	constructor(readonly label: HighlightedLabel) { }
}

export class TextEditElementRenderer implements ITreeRenderer<TextEditElement, FuzzyScore, TextEditElementTemplate> {

	static readonly id = 'TextEditElementRenderer';

	readonly templateId: string = TextEditElementRenderer.id;

	renderTemplate(container: HTMLElement): TextEditElementTemplate {
		const label = new HighlightedLabel(container, false);
		dom.addClass(label.element, 'textedit');
		return new TextEditElementTemplate(label);
	}

	renderElement({ element }: ITreeNode<TextEditElement, FuzzyScore>, _index: number, template: TextEditElementTemplate): void {

		let value = '';
		value += element.prefix;
		value += element.selecting;
		value += element.inserting;
		value += element.suffix;

		let selectHighlight: IHighlight = { start: element.prefix.length, end: element.prefix.length + element.selecting.length, extraClasses: 'remove' };
		let insertHighlight: IHighlight = { start: selectHighlight.end, end: selectHighlight.end + element.inserting.length, extraClasses: 'insert' };

		template.label.set(value, [selectHighlight, insertHighlight], undefined, true);
	}

	disposeTemplate(_template: TextEditElementTemplate): void { }
}

export class BulkEditDelegate implements IListVirtualDelegate<BulkEditElement> {

	getHeight(): number {
		return 23;
	}

	getTemplateId(element: BulkEditElement): string {
		return element instanceof FileElement
			? FileElementRenderer.id
			: TextEditElementRenderer.id;
	}
}
