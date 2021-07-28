
self.importScripts("brotli.js");

let overlayID = null;
let baseURL = 'http://127.0.0.1:8080/docs/';
let files = { '/d': true, 'test.txt': { b: 0, c: 7, s: 2 } };
let content = Uint8Array.from([0x21, 0x04, 0x00, 0x04, 0x4F, 0x4B, 0x03]).buffer;
let contentOffset = 0;
let mimeTypes = { '.txt': 'text/plain; charset=utf-8' };

function decompress(begin, compressed, size)
{
    let buffer = new Uint8Array(content, contentOffset + begin, compressed);
    if (compressed != size) {
        buffer = brotliDecompress(buffer, size);
    }
    return buffer;
}

this.addEventListener('install', e => {
    console.log('Overlay Service: install event');
    this.skipWaiting();
});

this.addEventListener('activate', e => {
    console.log('Overlay Service: activate event');
    e.waitUntil(this.clients.claim());
});

this.addEventListener('fetch', e => {
    console.log('Overlay Service: fetch event: ', e.request.url);
    if (!baseURL || !e.request.url.toString().startsWith(baseURL)) {
        console.log('Overlays disabled or not on base URL.');
        return e.request;
    }
    try {
        let path = e.request.url.toString().substr(baseURL.length);
        let pathArray = path.split('/').filter(x => x.length);
        let item = files;
        console.log('Path: ', pathArray);
        for (let itemName of pathArray) {
            if (!item['/d'] || !(itemName in item)) {
                console.log(`Not found '${itemName}').`);
                return e.request;
            }
            item = item[itemName];
        }
        if (item['/d']) {
            if ('index.html' in item) {
                item = item['index.html'];
            } else {
                console.log('Directory without index.');
                return e.request;
            }
        }
        let contentType = 'application/octet-stream';
        let fileName = pathArray[pathArray.length - 1] || '';
        let extPos = fileName.lastIndexOf('.');
        if (extPos > 0) {
            let ext = fileName.substr(extPos).toLowerCase();
            if (ext in mimeTypes) {
                contentType = mimeTypes[ext];
            }
        }
        console.log(`Respond with file starting at ${item.b} of size ${item.s} of type ${contentType}`);
        let blob = new Blob([decompress(item.b, item.c, item.s)]);
        e.respondWith(new Response(blob, {
            status: 200,
            statusText: 'OK',
            headers: { 'Content-Type': contentType }
        }));
    } catch (ex) {
        console.error(`Unexpected error during fetching file from overlay. Falling back to server request.`, ex);
    }
    return e.request;
});

void clearOverlay()
{
    overlayID = null;
    baseURL = null;
    files = null;
    content = null;
    mimeTypes = null;
}

void setOverlay(newBaseURL, newOverlayID, overlayContent)
{
    baseURL = newBaseURL;
    overlayID = newOverlayID;
    if (overlayContent instanceof ArrayBuffer) {
        content = overlayContent;
        contentOffset = 0;
    } else {
        content = overlayContent.buffer;
        contentOffset = overlayContent.byteOffset;
    }
    let view = new DataView(content, contentOffset);
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
    let filesBuffer = decompress(len - 12 - filesMapCompressed, filesMapCompressed, filesMapSize);
    files = JSON.parse((new TextDecoder()).decode(filesBuffer));
    mimeTypes = files['/mimeTypes'];
}

this.addEventListener('message', e => {
    console.log(`Overlay Service: message event: from ${e.source.id}, id ${e.data.id}`);
    switch (e.data.id) {
        case 'offer':
            e.source.postMessage({ id: 'offerResp', ok: !overlayID || overlayID != e.data.overlayID });
            break;
        case 'set':
            try {
                setOverlay(e.data.baseURL, e.data.overlayID, e.data.overlayContent);
                e.source.postMessage({ id: 'setResp', ok: true });
            } catch (ex) {
                clearOverlay();
                e.source.postMessage({ id: 'setResp', ok: false });
            }
            break;
        case 'clear':
            clearOverlay();
            e.source.postMessage({ id: 'clearResp', ok: true });
            break;
    }
});
