
self.importScripts("brotli.js");

const CACHE_LIMIT = 4 * 1024 * 1024;

const indexNames = [
    'index.html',
    'README.html'
];

class Overlay {

    constructor(id, baseURL, content) {
        this.id = id;
        this.baseURL = baseURL;
        if (content instanceof ArrayBuffer) {
            this.content = content;
            this.contentOffset = 0;
        } else {
            this.content = content.buffer;
            this.contentOffset = content.byteOffset;
        }
        this.files = null;
        this.mimeTypes = null;
    }

    init() {
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

class Cache {

    constructor() {
        this.list = [];
        this.size = 0;
    }

    add(newOverlay) {
        for (let i = 0; i < this.list; i++) {
            let overlay = this.list[i];
            if (overlay.id == newOverlay.id) {
                this.list.splice(i, 1);
                this.size -= overlay.content.byteLength;
                break;
            }
        }
        this.size += newOverlay.content.byteLength;
        this.list.unshift(newOverlay);
        this.removeOld();
    }

    get(id) {
        for (let i = 0; i < this.list; i++) {
            let overlay = this.list[i];
            if (overlay.id == id) {
                this.list.splice(i, 1);
                this.list.unshift(overlay);
                return overlay;
            }
        }
        return null;
    }

    removeOld() {
        while (this.list.length > 0 && this.size > CACHE_LIMIT) {
            let overlay = this.list.pop();
            this.size -= overlay.content.byteLength;
        }
    }
    
}

let overlay = null;
let cache = new Cache();

this.addEventListener('install', e => {
    console.log('Overlay Service: install event');
    this.skipWaiting();
});

this.addEventListener('activate', e => {
    console.log('Overlay Service: activate event');
    e.waitUntil(this.clients.claim());
});

this.addEventListener('fetch', e => {
    console.log('========================================================================');
    let url = new URL(e.request.url);
    console.log('Overlay Service: fetch event: ', url);
    if (!overlay) {
        console.log('Overlay disabled');
        return e.request;
    }
    try {
        let file = overlay.getFile(url.pathname);
        if (!file) {
            console.log('File not found in overlay');
            return e.request;
        }
        console.log(`File from overlay type "${file.contentType}", size ${file.content.byteLength}`);
        e.respondWith(new Response(new Blob([file.content]), {
            status: 200,
            statusText: 'OK',
            headers: { 'Content-Type': file.contentType }
        }));
    } catch (ex) {
        console.error(`Unexpected error during fetching file from overlay. Falling back to server request.`, ex);
    }
    return e.request;
});

this.addEventListener('message', e => {
    let response = {
        type: e.data.type + 'Resp',
        status: 'error'
    };
    console.log(`Overlay Service: message event: from ${e.source.id}, type ${e.data.type}`);
    try {
        switchStmt:
        switch (e.data.type) {
            case 'set':
                if (overlay) {
                    if (overlay.id == e.data.id) {
                        response.status = 'already';
                        break switchStmt;
                    }
                    overlay.reduce();
                }
                overlay = cache.get(e.data.id);
                if (overlay) {
                    overlay.init();
                    response.status = 'cached';
                    break switchStmt;
                }
                if (!e.data.content) {
                    response.status = 'missing';
                    break switchStmt;
                }
                overlay = new Overlay(e.data.id, e.data.baseURL, e.data.content);
                overlay.init();
                cache.add(overlay);
                response.status = 'ok';
                break;
            case 'clear':
                overlay = null;
                response.status = 'ok';
                break;
            case 'get':
                response.id = overlay ? overlay.id : null;
                response.status = 'ok';
        }
    } catch (ex) {
        response.status = 'error';
        response.message = ex.toString();
    }
    console.log('Message to client', response);
    e.source.postMessage(response);
});
