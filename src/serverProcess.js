console.log("Launched server process");

function initialize(data) {
    /** @type { MessagePort } */
    const stdoutPort = data.stdoutPort;
    /** @type { MessagePort } */
    const stderrPort = data.stderrPort;
    /** @type { SharedArrayBuffer } */
    const stdinBuffer = data.stdinBuffer;
    /** @type { string } */
    const extensionUri = data.extensionUri;
    const stdinSignal = new Int32Array(stdinBuffer, 0, 1);
    const stdinLength = new Uint32Array(stdinBuffer, 4, 1);
    const stdinRawBuffer = new Uint8Array(stdinBuffer, 8);
    const stdinData = [];
    let stdoutData = [];
    let carretCount = 0;
    const textDecoder = new TextDecoder();

    self.Module = {
        arguments: [ "--log=verbose" ],
        thisProgram: "/usr/bin/clangd.wasm",
        stdin() {
            while (stdinData.length === 0) {
                Atomics.wait(stdinSignal, 0, 0, 10000);
                Atomics.store(stdinSignal, 0, 0);

                const stdinBuffer = [...stdinRawBuffer.slice(0, stdinLength[0])];

                console.log("--> " + textDecoder.decode(stdinRawBuffer.slice(0, stdinLength[0])));
                stdinData.push(...stdinBuffer, null);
            }
            return stdinData.shift();
        },
        stdout(char) {
            stdoutData.push(char);

            const prevCarretCount = carretCount;

            if (char === 123) {
                carretCount++;
            } else if (char === 125) {
                carretCount--;
            }

            if (prevCarretCount == 1 && carretCount == 0) {
                const buffer = new Uint8Array(stdoutData);
                const text = textDecoder.decode(buffer);

                console.log("--- " + text);

                stdoutPort.postMessage(text);

                stdoutData = [];
            }
        },
        printErr(text) {
            console.log("ServerProcess: " + text);
            stderrPort.postMessage(text);
        },
        locateFile(url) {
            return extensionUri + "/dist/" + url;
        },
        mainScriptUrlOrBlob: extensionUri + "/dist/clangd.js",
        createWorker(url) {        
            
                const blob = new Blob([
                    `
                        self.Module = {
                            locateFile(url) {
                                console.log(url);
                                return "${extensionUri}/dist/" + url;
                            }
                        };
                        
                        importScripts("${url}");
                    `   
                ], { type: "text/javascript" });
                    
                const blobURL = URL.createObjectURL(blob);
                const worker = new Worker(blobURL, { name: "clangdThread" });
                return worker;
        }
    };

    importScripts(extensionUri + "/dist/clangd.js");
}

self.onmessage = function(e) {
    initialize(e.data);
}
