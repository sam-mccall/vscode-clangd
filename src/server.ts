import { BrowserMessageReader, BrowserMessageWriter, ResponseMessage } from 'vscode-languageserver/browser';
import { ServerContext } from './clangd-context';

self.onmessage = function(e) {
    self.onmessage = null;

    const context = e.data as ServerContext;

    const stdoutPort = context.stdoutPort;
    const stdinBuffer = context.stdinBuffer;

    const stdinSignal = new Int32Array(stdinBuffer, 0, 1);
    const stdinLength = new Uint32Array(stdinBuffer, 4, 1);
    const stdinRawBuffer = new Uint8Array(stdinBuffer, 8);

    const textEncoder = new TextEncoder();

    const messageReader = new BrowserMessageReader(self);
    const messageWriter = new BrowserMessageWriter(self);

    messageReader.listen(data => {
        const text = JSON.stringify(data);

        const message = `Content-Length: ${ text.length }\r\n\r\n${ text }`
        const buffer = textEncoder.encode(message);

        stdinLength[0] = buffer.length;
        stdinRawBuffer.set(buffer);
        
        Atomics.store(stdinSignal, 0, 1);
        Atomics.notify(stdinSignal, 0);
    });

    stdoutPort.addEventListener("message", (e) => {
        if (typeof e.data === "string") {
            const text = e.data;
            const body = text.substring(text.search("{"));

            const response = JSON.parse(body) as ResponseMessage;
            messageWriter.write(response);
        }
    });
    stdoutPort.start();
}
