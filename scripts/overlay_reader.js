
let diffbrotli = null;

class OverlayReader {

    constructor(content) {
        if (content instanceof ArrayBuffer) {
            this.content = content;
            this.contentOffset = 0;
        } else {
            this.content = content.buffer;
            this.contentOffset = content.byteOffset;
        }
        this.files = null;
        this.mimeTypes = null;
        this.onfetch = null;
    }

    async initDiffbrotli() {
        try {
            while (diffbrotli === true) {
                await new Promise(resolve => { setTimeout(resolve, 100); });
            }
            if (diffbrotli !== null) return;
            WebAssembly.instantiateStreaming(fetch('simple.wasm'), importObject)
        } catch (ex) {
            diffbrotli = null;
        }
    }

    async init() {
        let view = new DataView(this.content, this.contentOffset);
        let len = view.byteLength;
        if (view.getUint32(0) != 0x4f76726c || len < 16) {
            throw Error('Invalid overlay header');
        }
        if (view.getUint32(len - 4) != 0x6c72764f) {
            throw Error('Invalid overlay footer');
        }
        let filesMapSize = view.getUint32(len - 8, true);
        let filesMapCompressed = view.getUint32(len - 12, true);
        if (filesMapCompressed > len - 16) {
            throw Error('Invalid overlay footer');
        }
        let filesBuffer = this.decompress(len - 12 - filesMapCompressed, filesMapCompressed, filesMapSize);
        this.files = JSON.parse((new TextDecoder()).decode(filesBuffer));
        this.mimeTypes = this.files['/mimeTypes'];
        await this.initDiffbrotli();
    }

    reduce() {
        this.files = null;
        this.mimeTypes = null;
    }

    getFile(url) {
        if (!url.startsWith(this.baseURL)) {
            console.log(`URL "${url}" on in baseURL "${this.baseURL}"`);
            return null;
        }
        if (this.files == null) {
            this.init();
        }
        let path = url.substr(this.baseURL.length);
        let pathArray = path.split('/').filter(x => x.length);
        console.log(pathArray);
        let item = this.files;
        for (let itemName of pathArray) {
            if (!item['/d'] || !(itemName in item)) {
                console.log(`Not found '${itemName}').`);
                return null;
            }
            item = item[itemName];
        }
        if (item['/d']) {
            let index = indexNames.find(x => x in item);
            if (index) {
                item = item[index];
                pathArray.push(index);
            } else {
                console.log('Directory without index.');
                return null;
            }
        }
        console.log(`File in overlay @${item.b}, size ${item.s}, compressed ${item.c}`);
        let content = this.decompress(item.b, item.c, item.s);
        let contentType = 'application/octet-stream';
        let fileName = pathArray[pathArray.length - 1] || '';
        let extPos = fileName.lastIndexOf('.');
        if (extPos > 0) {
            let ext = fileName.substr(extPos).toLowerCase();
            if (ext in this.mimeTypes) {
                contentType = this.mimeTypes[ext];
            }
        }
        return { content, contentType }
    }

    decompress(begin, compressed, size)
    {
        let buffer = new Uint8Array(this.content, this.contentOffset + begin, compressed);
        if (compressed != size) {
            buffer = brotliDecompress(buffer, size);
        }
        return buffer;
    }
}

exports.OverlayReader = OverlayReader;
