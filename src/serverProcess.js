import { TextWriter, Uint8ArrayReader, ZipReader, fs } from "@zip.js/zip.js";

console.log("Launched server process");

function patchWorker() {
    //
    // Using JS file from another origin produces cross-origin error.
    // Just wrapping worker entrypoint.
    //
    const originalWorker = Worker;

    self.Worker = function(url, option) {
        const blob = new Blob([ `importScripts("${url}");` ], { type: "text/javascript" });            
        const blobURL = URL.createObjectURL(blob);
        if (!option) {
            option = { name: "clangd Worker" };
        }
        return new originalWorker(blobURL, option);
    };
}

patchWorker();

/**
 * 
 * @param { string } path 
 * @param { string | Uint8Array } content 
 */
function writeFile(path, content) {
    const components = path.split("/");
    let creatingPath = "/";

    for (let i = 1; i < components.length - 1; i++) {
        creatingPath += (components[i] + "/");
        try {
            FS.mkdir(creatingPath);
        } catch (e) {
            // ignore
        }
    }
    console.log("writing: " + path);
    FS.writeFile(path, content);
}

async function fetchAndInstallHeaders(url, base) {
    const bootstrap = await fetch(url);
    const bootstrapBuffer = await bootstrap.arrayBuffer();
    
    const fileReader = new Uint8ArrayReader(new Uint8Array(bootstrapBuffer));
    const zipReader = new ZipReader(fileReader);
    const files = await zipReader.getEntries(); 

    const promises = files.map(async file => {
        const textWriter = new TextWriter("utf8");
        const content = await file.getData(textWriter);
        writeFile(base + file.filename, content);
    });
    
    await Promise.all(promises); 
}

async function loadInitialFiles(extensionUri) {

    writeFile("/home/web_user/.config/clangd/config.yaml",
    `
CompileFlags:
    Add: [--target=wasm32-unknown]     
    `
    );

    await Promise.all([
        fetchAndInstallHeaders(extensionUri + "/clangd/clang_includes.zip", "/usr/include/"),
        fetchAndInstallHeaders(extensionUri + "/clangd/emscripten_includes.zip", "/usr/include/emscripten/"),
        fetchAndInstallHeaders(extensionUri + "/clangd/Siv3D_includes.zip", "/usr/include/Siv3D/")
    ]);
}

async function initialize(data) {
    /** @type { MessagePort } */
    const commandPort = data.commandPort;
    /** @type { MessagePort } */
    const stdinPort = data.stdinPort;
    /** @type { MessagePort } */
    const stdoutPort = data.stdoutPort;
    /** @type { MessagePort } */
    const stderrPort = data.stderrPort;
    /** @type { string } */
    const extensionUri = data.extensionUri;
    
    /** @type { Uint8Array[] } */
    const stdinQueue = [];
    /** @type { number[] }  */
    const stdinData = [];
    let stdoutData = [];

    let carretCount = 0;
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();

    self.Module = {
        arguments: [ ],
        thisProgram: "/usr/bin/clangd.wasm",
        waitForStdin() {
            if (stdinQueue.length === 0) {
                // Need to wait
                return new Promise(resolve => {
                    Module["waitForStdinPromise"] = resolve;
                });
            } else {
                return Promise.resolve();
            }
        },
        waitForStdinPromise: null,
        stdin() {
            while (stdinData.length === 0) {
                if (stdinQueue.length == 0) {
                    stdinData.push(...textEncoder.encode("Content-Length: 0\r\n\r\n"), null);
                    break;
                }
            
                const stdinBuffer = stdinQueue.shift();
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

            // The last of LSP message does not have '/n'.
            // Detect when parens are closed.
            if (prevCarretCount == 1 && carretCount == 0) {
                const buffer = new Uint8Array(stdoutData);
                const text = textDecoder.decode(buffer);

                stdoutPort.postMessage({
                    type: "stdout",
                    data: text
                });

                stdoutData = [];
            }
        },
        printErr(text) {
            stderrPort.postMessage(text);
        },
        locateFile(url) {
            return extensionUri + "/clangd/" + url;
        },
        mainScriptUrlOrBlob: extensionUri + "/clangd/clangd.js",
        onExit(code) {
            stdoutPort.postMessage({ 
                type: "exit",
                code
            })
        }
    };

    importScripts(extensionUri + "/clangd/clangd.js");

    stdinPort.onmessage = function(e) {
        const data = e.data;

        if (data && data.type === "stdin") {
            stdinQueue.push(new Uint8Array(data.buffer));

            if (!!Module["waitForStdinPromise"]) {
                const resume = Module["waitForStdinPromise"];
                Module["waitForStdinPromise"] = null;
                resume();
            }
        } 
    };

    commandPort.onmessage = function (e) {
        const data = e.data;

        if (!data) {
            return;
        }

        if (data.type === "create" || data.type === "change") {
            /** @type { string } */
            const fsPath = data.data.path;
            /** @type { string | ArrayBuffer } */
            const buffer = data.data.buffer;

            if (typeof buffer === "string") {
                writeFile(fsPath, buffer);
            } else {
                const offset = data.data.offset;
                const length = data.data.length;

                writeFile(fsPath, new Uint8Array(buffer, offset, length));
            }
        }
    };

    await loadInitialFiles(extensionUri);
}

self.onmessage = function(e) {
    initialize(e.data);
}
