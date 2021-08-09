
let diffbrotliInstance = null;
let diffbrotliSource = null;
let diffbrotliMemory = null;

function diffbrotliInit(source, streaming) {
    diffbrotliSource = { source, streaming };
}

async function diffbrotliInstantiate() {
    try {
        while (diffbrotliInstance === true) {
            await new Promise(resolve => { setTimeout(resolve, 100); });
        }
        if (diffbrotliInstance !== null) {
            return;
        }
        diffbrotliInstance = true;
        diffbrotliMemory = new WebAssembly.Memory({ initial: 16 });
        let result;
        let importObject = { env: { memory: diffbrotliMemory } };
        if (diffbrotliSource.streaming) {
            result = await WebAssembly.instantiateStreaming(diffbrotliSource.source, importObject);
        } else {
            result = await WebAssembly.instantiate(diffbrotliSource.source, importObject);
        }
        diffbrotliInstance = result.instance;
    } finally {
        if (diffbrotliInstance === true) {
            diffbrotliInstance = null;
        }
    }
}

async function diffbrotliDecompress(base, input, outputSize) {
    await diffbrotliInstantiate();
    let ptr = diffbrotliInstance.exports.decodeBegin(base ? base.byteLength : 0, input.byteLength, outputSize);
    if (ptr == 0) {
        throw Error(`Cannot decompress brotli stream: decodeBegin error`);
    }
    let view = new DataView(diffbrotliMemory.buffer);
    let basePtr = view.getUint32(ptr, false);
    let inputPtr = view.getUint32(ptr + 4, false);
    let outputPtr = view.getUint32(ptr + 8, false);
    if (base && base.byteLength > 0) {
        (new Uint8Array(diffbrotliMemory.buffer, basePtr, base.byteLength)).set(base);
    }
    (new Uint8Array(diffbrotliMemory.buffer, inputPtr, base.byteLength)).set(input);
    let bytes = diffbrotliInstance.exports.decode(base ? base.byteLength : 0, input.byteLength, outputSize);
    if (bytes != outputSize) {
        throw Error(`Cannot decompress brotli stream: decode error`);
    }
    let result = (new Uint8Array(diffbrotliMemory.buffer, outputPtr, outputSize)).slice();
    diffbrotliInstance.exports.decodeEnd();
    return result;
}

