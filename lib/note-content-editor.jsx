import React, { PropTypes } from 'react';
import {
	ContentState,
	Editor,
	EditorState,
	Modifier,
} from 'draft-js';
import { invoke, noop } from 'lodash';

function plainTextContent( editorState ) {
	return editorState.getCurrentContent().getPlainText( '\n' )
}

function getCurrentBlock( editorState ) {
	const key = editorState.getSelection().getFocusKey();
	return editorState.getCurrentContent().getBlockForKey( key );
}

function indentCurrentBlock( editorState ) {
	const selection = editorState.getSelection();
	const selectionStart = selection.getStartOffset();

	const line = getCurrentBlock( editorState ).getText();
	const atStart = line.trim() === '-' || line.trim() === '*';
	const offset = atStart ? 0 : selectionStart;

	// add tab
	const afterInsert = EditorState.push(
		editorState,
		Modifier.replaceText(
			editorState.getCurrentContent(),
			selection.isCollapsed()
				? selection.merge( {
					anchorOffset: offset,
					focusOffset: offset,
				} )
				: selection,
			'\t'
		),
		'insert-characters'
	);

	// move selection to where it was
	return EditorState.forceSelection(
		afterInsert,
		afterInsert.getSelection().merge( {
			anchorOffset: selectionStart + 1, // +1 because 1 char was added
			focusOffset: selectionStart + 1,
		} )
	);
}

function outdentCurrentBlock( editorState ) {
	const selection = editorState.getSelection();
	const selectionStart = selection.getStartOffset();

	const line = getCurrentBlock( editorState ).getText();
	const atStart = line.trim() === '-' || line.trim() === '*';
	const rangeStart = atStart ? 0 : selectionStart - 1;
	const rangeEnd = atStart ? 1 : selectionStart;

	const prevChar = line.slice( rangeStart, rangeEnd );
	// there's no indentation to remove
	if ( prevChar !== '\t' ) {
		return editorState
	}

	// remove tab
	const afterRemove = EditorState.push(
		editorState,
		Modifier.removeRange(
			editorState.getCurrentContent(),
			selection.merge( {
				anchorOffset: rangeStart,
				focusOffset: rangeEnd,
			} )
		),
		'remove-range'
	);

	// move selection to where it was
	return EditorState.forceSelection(
		afterRemove,
		selection.merge( {
			anchorOffset: selectionStart - 1, // -1 because 1 char was removed
			focusOffset: selectionStart - 1,
		} )
	);
}

function finishList( editorState ) {
	// remove `- ` from the current line
	const withoutBullet = EditorState.push(
		editorState,
		Modifier.removeRange(
			editorState.getCurrentContent(),
			editorState.getSelection().merge( {
				anchorOffset: 0,
				focusOffset: getCurrentBlock( editorState ).getLength(),
			} )
		),
		'remove-range'
	);

	// move selection to the start of the line
	return EditorState.forceSelection(
		withoutBullet,
		withoutBullet.getCurrentContent().getSelectionAfter()
	);
}

function continueList( editorState, listItemMatch ) {
	// create a new line
	const withNewLine = EditorState.push(
		editorState,
		Modifier.splitBlock(
			editorState.getCurrentContent(),
			editorState.getSelection()
		),
		'split-block'
	);

	// insert `- ` in the new line
	const withBullet = EditorState.push(
		withNewLine,
		Modifier.insertText(
			withNewLine.getCurrentContent(),
			withNewLine.getCurrentContent().getSelectionAfter(),
			listItemMatch[0]
		),
		'insert-characters'
	);

	// move selection to the end of the new line
	return EditorState.forceSelection(
		withBullet,
		withBullet.getCurrentContent().getSelectionAfter()
	);
}

export default class NoteContentEditor extends React.Component {
	static propTypes = {
		content: PropTypes.string.isRequired,
		onChangeContent: PropTypes.func.isRequired
	}

	state = {
		editorState: EditorState.createWithContent(
			ContentState.createFromText( this.props.content, '\n' )
		)
	}

	saveEditorRef = ( ref ) => {
		this.editor = ref
	}

	handleEditorStateChange = ( editorState ) => {
		if ( editorState === this.state.editorState ) {
			return
		}

		const nextContent = plainTextContent( editorState );
		const prevContent = plainTextContent( this.state.editorState );

		const announceChanges = nextContent !== prevContent
			? () => this.props.onChangeContent( nextContent )
			: noop;

		this.setState( { editorState }, announceChanges );
	}

	componentWillReceiveProps( { content: newContent } ) {
		const { content: oldContent } = this.props;
		const { editorState: oldEditorState } = this.state;

		if ( newContent === oldContent ) {
			return; // identical to previous `content` prop
		}

		if ( newContent === plainTextContent( oldEditorState ) ) {
			return; // identical to rendered content
		}

		let newEditorState = EditorState.createWithContent(
			ContentState.createFromText( newContent, '\n' )
		)

		// avoids weird caret position if content is changed
		// while the editor had focus, see
		// https://github.com/facebook/draft-js/issues/410#issuecomment-223408160
		if ( oldEditorState.getSelection().getHasFocus() ) {
			newEditorState = EditorState.moveFocusToEnd( newEditorState )
		}

		this.setState( { editorState: newEditorState } );
	}

	focus = () => {
		invoke( this, 'editor.focus' );
	}

	onTab = ( e ) => {
		const { editorState } = this.state;

		// prevent moving focus to next input
		e.preventDefault()

		if ( ! editorState.getSelection().isCollapsed() && e.shiftKey ) {
			return
		}

		if ( e.altKey || e.ctrlKey || e.metaKey ) {
			return
		}

		this.handleEditorStateChange(
			e.shiftKey
				? outdentCurrentBlock( editorState )
				: indentCurrentBlock( editorState )
		)
	}

	handleReturn = () => {
		// matches lines that start with `- ` or `* `
		// preceded by 0 or more tab characters
		const listItemRe = /^\t*[-*]\s/;

		const { editorState } = this.state;
		const line = getCurrentBlock( editorState ).getText();

		const trimmedLine = line.trim()
		if ( trimmedLine === '-' || trimmedLine === '*' ) {
			this.handleEditorStateChange( finishList( editorState ) );
			return 'handled'
		}

		const listItemMatch = line.match( listItemRe )
		if ( listItemMatch ) {
			this.handleEditorStateChange( continueList( editorState, listItemMatch ) );
			return 'handled'
		}

		return 'not-handled';
	}

	render() {
		return (
			<Editor
				ref={this.saveEditorRef}
				spellCheck
				stripPastedStyles
				onChange={this.handleEditorStateChange}
				editorState={this.state.editorState}
				onTab={this.onTab}
				handleReturn={this.handleReturn}
			/>
		);
	}
}
