console.log("launched server process");

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
        stdin() {
            while (stdinData.length === 0) {
                console.log("waiting input...")
                Atomics.wait(stdinSignal, 0, 0, 10000);
                console.log("Recieve Length: " + stdinLength[0]);
                Atomics.store(stdinSignal, 0, 0);

                const stdinBuffer = [...stdinRawBuffer.slice(0, stdinLength[0])];
                stdinData.push(...stdinBuffer, null);
            }
            return stdinData.shift();
        },
        // print(text) {
        //     console.log("Process: " + text);
        //     stdoutPort.postMessage(text);
        // },
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

                console.log("Process: " + text);
                stdoutPort.postMessage(text);

                stdoutData = [];
            }
        },
        printErr(text) {
            console.log("Process Error: " + text);
            stderrPort.postMessage(text);
        },
        locateFile(url) {
            return extensionUri + "/dist/" + url;
        },
        createWorker(url) {
            console.log("new worker:" + url);
            
            const blob = new Blob([
                `
                    self.Module = {
                        locateFile(url) {
                            return "${extensionUri}/dist/" + url;
                        }
                    };
                    importScripts("${url}");
                `   
            ]);
                
            const blobURL = URL.createObjectURL(blob);
            return new Worker(blobURL);
        }
    };

    importScripts(extensionUri + "/dist/clangd.js");
}

self.onmessage = function(e) {
    initialize(e.data);
}
