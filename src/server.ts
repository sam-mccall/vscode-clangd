import {
  BrowserMessageReader,
  BrowserMessageWriter,
  ResponseMessage
} from 'vscode-languageserver/browser';

import {ServerContext} from './clangd-context';

self.onmessage = function(e) {
  self.onmessage = null;

  const context = e.data as ServerContext;

  const stdinPort = context.stdinPort;
  const stdoutPort = context.stdoutPort;

  const textEncoder = new TextEncoder();

  const messageReader = new BrowserMessageReader(self);
  const messageWriter = new BrowserMessageWriter(self);

  messageReader.listen(data => {
    let text = JSON.stringify(data);
    text = text.replace(/([a-z0-9+\-.]+):\/([a-zA-Z0-9+\-\/\.]+)/g, "file://$1/$2");

    const message =
        `Content-Length: ${textEncoder.encode(text).length}\r\n\r\n${text}`
    const buffer = textEncoder.encode(message);

    stdinPort.postMessage({type: 'stdin', buffer: buffer.buffer},
                          [buffer.buffer]);
  });

  stdoutPort.addEventListener('message', (e) => {
    const data = e.data as {type: string, data: any} | undefined;

    if (!data) {
      return;
    }

    if (data.type === 'stdout') {
      let text = data.data as string;
      text = text.replace(/file:\/\/([a-z0-9+\-.]+)\/([a-zA-Z0-9+\-\/\.]+)/, "$1:/$2");
      const body = text.substring(text.search('{'));

      const response = JSON.parse(body) as ResponseMessage;
      messageWriter.write(response);
    } else if (data.type === 'exit') {
      messageWriter.end();
      messageWriter.dispose();
    }
  });
  stdoutPort.start();
}
