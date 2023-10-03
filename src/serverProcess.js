console.log("Launched server process");

function initialize(data) {
    /** @type { MessagePort } */
    const commandPort = data.commandPort;
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
        arguments: [ ],
        thisProgram: "/usr/bin/clangd.wasm",
        stdin() {
            while (stdinData.length === 0) {
                Atomics.wait(stdinSignal, 0, 0, 10000);
                Atomics.store(stdinSignal, 0, 0);

                const stdinBuffer = [...stdinRawBuffer.slice(0, stdinLength[0])];
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

                stdoutPort.postMessage(text);

                stdoutData = [];
            }
        },
        printErr(text) {
            stderrPort.postMessage(text);
        },
        locateFile(url) {
            return extensionUri + "/dist/" + url;
        },
        mainScriptUrlOrBlob: extensionUri + "/dist/clangd.js",
    };

    const originalWorker = Worker;

    self.Worker = function(url, option) {
        const blob = new Blob([ `importScripts("${url}");` ], { type: "text/javascript" });            
        const blobURL = URL.createObjectURL(blob);
        if (!option) {
            option = { name: "clangd Worker" };
        }
        return new originalWorker(blobURL, option);
    };

    importScripts(extensionUri + "/dist/clangd.js");

    commandPort.onmessage = function (e) {
        const data = e.data;

        if (data.type === "create" || data.type === "change") {
            const fsPath = data.data.path;
            const buffer = data.data.buffer;

            const components = fsPath.split("/");
            let creatingPath = "/";

            for (let i = 1; i < components.length - 1; i++) {
                creatingPath += components[i];
                try {
                    FS.mkdir(creatingPath);
                } catch (e) {
                    // ignore
                }
            }

            FS.writeFile(fsPath, buffer);
        }
    };

    FS.mkdir("/home/web_user/.config/");
    FS.mkdir("/home/web_user/.config/clangd");
    FS.writeFile("/home/web_user/.config/clangd/config.yaml", `
CompileFlags:\n
    Add: [--target=wasm32-unknown]     
    `);
}

self.onmessage = function(e) {
    initialize(e.data);
}
