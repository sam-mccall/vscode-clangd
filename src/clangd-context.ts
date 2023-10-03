import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/browser';

import * as ast from './ast';
import * as config from './config';
import * as configFileWatcher from './config-file-watcher';
import * as fileStatus from './file-status';
import * as inactiveRegions from './inactive-regions';
import * as inlayHints from './inlay-hints';
// import * as install from './install';
import * as memoryUsage from './memory-usage';
import * as openConfig from './open-config';
import * as switchSourceHeader from './switch-source-header';
import * as typeHierarchy from './type-hierarchy';

export const clangdDocumentSelector = [
  {scheme: 'file', language: 'c'},
  {scheme: 'file', language: 'cpp'},
  {scheme: 'file', language: 'cuda-cpp'},
  {scheme: 'file', language: 'objective-c'},
  {scheme: 'file', language: 'objective-cpp'},
];

export function isClangdDocument(document: vscode.TextDocument) {
  return vscode.languages.match(clangdDocumentSelector, document);
}

class ClangdLanguageClient extends vscodelc.LanguageClient {
  // Override the default implementation for failed requests. The default
  // behavior is just to log failures in the output panel, however output panel
  // is designed for extension debugging purpose, normal users will not open it,
  // thus when the failure occurs, normal users doesn't know that.
  //
  // For user-interactive operations (e.g. applyFixIt, applyTweaks), we will
  // prompt up the failure to users.

  stop(timeout?: number): Promise<void> {
    return Promise.resolve();
  }

  handleFailedRequest<T>(type: vscodelc.MessageSignature, error: any,
                         token: vscode.CancellationToken|undefined,
                         defaultValue: T): T {
    if (error instanceof vscodelc.ResponseError &&
        type.method === 'workspace/executeCommand')
      vscode.window.showErrorMessage(error.message);

    return super.handleFailedRequest(type, token, error, defaultValue);
  }
}

class EnableEditsNearCursorFeature implements vscodelc.StaticFeature {
  initialize() {}
  fillClientCapabilities(capabilities: vscodelc.ClientCapabilities): void {
    const extendedCompletionCapabilities: any =
        capabilities.textDocument?.completion;
    extendedCompletionCapabilities.editsNearCursor = true;
  }
  getState(): vscodelc.FeatureState { return {kind: 'static'}; }
  dispose() {}
}

export interface ServerContext {
  extensionUri: string;
  stdoutPort: MessagePort;
  stdinBuffer: SharedArrayBuffer;
}

export interface ServerProcessContext {
  extensionUri: string;
  commandPort: MessagePort;
  stdoutPort: MessagePort;
  stderrPort: MessagePort;
  stdinBuffer: SharedArrayBuffer;
}

function setupServer(extensionUri: vscode.Uri, context: ServerContext): Worker {
  const workerPath = vscode.Uri.joinPath(extensionUri, "./dist/server.js");
  const worker = new Worker(workerPath.toString(true));

  worker.postMessage(context, [ context.stdoutPort ]);

  return worker;
}

function setupServerProcess(extensionUri: vscode.Uri, context: ServerProcessContext): Worker {
  const workerPath = vscode.Uri.joinPath(extensionUri, "./dist/serverProcess.js");
  const worker = new Worker(workerPath.toString(true));

  worker.postMessage(context, [ context.commandPort, context.stdoutPort, context.stderrPort ]);

  return worker;
}

export class ClangdContext implements vscode.Disposable {
  subscriptions: vscode.Disposable[] = [];
  client!: ClangdLanguageClient;

  async activate(extensionUri: vscode.Uri,
                 outputChannel: vscode.OutputChannel) {
    // const clangdPath = await install.activate(this, globalStoragePath);
    // if (!clangdPath)
    //   return;
    
    // const traceFile = config.get<string>('trace');
    // if (!!traceFile) {
    //   const trace = {CLANGD_TRACE: traceFile};
    //   clangd.options = {env: {...process.env, ...trace}};
    // }

    const commandChannel = new MessageChannel();
    const stdoutChannel = new MessageChannel();
    const stderrChannel = new MessageChannel();
    const stdinBuffer = new SharedArrayBuffer(64 * 1024 + 8);

    const serverContext: ServerContext = {
      extensionUri: extensionUri.toString(),
      stdoutPort: stdoutChannel.port1,
      stdinBuffer
    };

    const clangd = setupServer(extensionUri, serverContext);

    const serverProcessContext: ServerProcessContext = {
      extensionUri: extensionUri.toString(),
      commandPort: commandChannel.port2,
      stdoutPort: stdoutChannel.port2,
      stderrPort: stderrChannel.port2,
      stdinBuffer
    };

    const clangdProcess = setupServerProcess(extensionUri, serverProcessContext);

    const stderrPort = stderrChannel.port1;
    const commandPort = commandChannel.port1;

    stderrPort.addEventListener("message", e => {
      if (typeof e.data === "string") {
        outputChannel.appendLine(e.data);
      }
    });
    stderrPort.start();

    vscode.workspace.onDidOpenTextDocument(e => {
      const uri = e.uri;
      const buffer = e.getText();

      commandPort.postMessage({
        type: "create",
        data: {
          path: uri.path,
          buffer: buffer
        }
      });
    });

    vscode.workspace.onDidChangeTextDocument(e => {
      const uri = e.document.uri;
      const buffer = e.document.getText();

      commandPort.postMessage({
        type: "change",
        data: {
          path: uri.path,
          buffer: buffer
        }
      });
    });
   
    
    const clientOptions: vscodelc.LanguageClientOptions = {
      // Register the server for c-family and cuda files.
      documentSelector: clangdDocumentSelector,
      initializationOptions: {
        clangdFileStatus: true,
        fallbackFlags: config.get<string[]>('fallbackFlags')
      },
      outputChannel: outputChannel,
      // Do not switch to output window when clangd returns output.
      revealOutputChannelOn: vscodelc.RevealOutputChannelOn.Never,

      // We hack up the completion items a bit to prevent VSCode from re-ranking
      // and throwing away all our delicious signals like type information.
      //
      // VSCode sorts by (fuzzymatch(prefix, item.filterText), item.sortText)
      // By adding the prefix to the beginning of the filterText, we get a
      // perfect
      // fuzzymatch score for every item.
      // The sortText (which reflects clangd ranking) breaks the tie.
      // This also prevents VSCode from filtering out any results due to the
      // differences in how fuzzy filtering is applies, e.g. enable dot-to-arrow
      // fixes in completion.
      //
      // We also mark the list as incomplete to force retrieving new rankings.
      // See https://github.com/microsoft/language-server-protocol/issues/898
      middleware: {
        provideCompletionItem: async (document, position, context, token,
                                      next) => {
          let list = await next(document, position, context, token);
          if (!config.get<boolean>('serverCompletionRanking'))
            return list;
          let items = (Array.isArray(list) ? list : list!.items).map(item => {
            // Gets the prefix used by VSCode when doing fuzzymatch.
            let prefix = document.getText(
                new vscode.Range((item.range as vscode.Range).start, position))
            if (prefix)
            item.filterText = prefix + '_' + item.filterText;
            // Workaround for https://github.com/clangd/vscode-clangd/issues/357
            // clangd's used of commit-characters was well-intentioned, but
            // overall UX is poor. Due to vscode-languageclient bugs, we didn't
            // notice until the behavior was in several releases, so we need
            // to override it on the client.
            item.commitCharacters = [];
            return item;
          })
          return new vscode.CompletionList(items, /*isIncomplete=*/ true);
        },
        // VSCode applies fuzzy match only on the symbol name, thus it throws
        // away all results if query token is a prefix qualified name.
        // By adding the containerName to the symbol name, it prevents VSCode
        // from filtering out any results, e.g. enable workspaceSymbols for
        // qualified symbols.
        provideWorkspaceSymbols: async (query, token, next) => {
          let symbols = await next(query, token);
          return symbols?.map(symbol => {
            // Only make this adjustment if the query is in fact qualified.
            // Otherwise, we get a suboptimal ordering of results because
            // including the name's qualifier (if it has one) in symbol.name
            // means vscode can no longer tell apart exact matches from
            // partial matches.
            if (query.includes('::')) {
              if (symbol.containerName)
                symbol.name = `${symbol.containerName}::${symbol.name}`;
              // Clean the containerName to avoid displaying it twice.
              symbol.containerName = '';
            }
            return symbol;
          })
        },
      },
    };

    this.client = new ClangdLanguageClient('vscode-clangd-web',
        'Clang Language Server', clientOptions, clangd);
    this.client.clientOptions.errorHandler =
        this.client.createDefaultErrorHandler(
            // max restart count
            config.get<boolean>('restartAfterCrash') ? /*default*/ 4 : 0);
    this.client.registerFeature(new EnableEditsNearCursorFeature);
    typeHierarchy.activate(this);
    inlayHints.activate(this);
    memoryUsage.activate(this);
    ast.activate(this);
    openConfig.activate(this);
    inactiveRegions.activate(this);
    this.client.start();
    console.log('Clang Language Server is now active!');
    fileStatus.activate(this);
    switchSourceHeader.activate(this);
    configFileWatcher.activate(this);
  }

  get visibleClangdEditors(): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter(
        (e) => isClangdDocument(e.document));
  }

  dispose() {
    this.subscriptions.forEach((d) => { d.dispose(); });
    if (this.client)
      this.client.stop();
    this.subscriptions = []
  }
}
