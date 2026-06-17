import {
	createConnection,
	TextDocuments,
	TextDocumentSyncKind,
	ProposedFeatures,
	InitializeParams,
	InitializeResult,
	TextDocumentChangeEvent,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

connection.onInitialize((_params: InitializeParams): InitializeResult => {
	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
		},
	};
});

connection.onInitialized(() => {
	connection.console.log('LingµChain Embedded C server initialized');
});

documents.onDidOpen((event: TextDocumentChangeEvent<TextDocument>) => {
	connection.console.log(`Document opened: ${event.document.uri}`);
});

documents.onDidChangeContent((event: TextDocumentChangeEvent<TextDocument>) => {
	connection.console.log(`Document changed: ${event.document.uri}`);
});

documents.onDidClose((event: TextDocumentChangeEvent<TextDocument>) => {
	connection.console.log(`Document closed: ${event.document.uri}`);
});

documents.listen(connection);
connection.listen();
