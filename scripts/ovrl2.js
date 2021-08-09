
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const child_process = require('child_process');
const { OverlayReader } = require('./overlay_reader');

const STATE = {
    DELETED: 'DELETED',
    MODIFIED: 'MODIFIED',
    CREATED: 'CREATED',
    UNCHANGED: 'UNCHANGED',
    LINK: 'LINK',
};

let fileMap = {
    files: {},
    upFileHash: {},
    downFileHash: {},
    downChunkHash: {},
};

let totalUpBytes = 0;

function fileMatch(path, fileName) {
    return !fileName.startsWith('.');
}

function calcHashes(path, size) {
    let globalHash = crypto.createHash('sha256');
    let buf = Buffer.alloc(128);
    let fd = fs.openSync(path, 'r');
    globalHash.update(size.toString());
    let chunks = [];
    let readOffset = 0;
    while (readOffset < size) {
        if (readOffset + buf.length > size) {
            readOffset = Math.max(0, size - buf.length);
        }
        let n = fs.readSync(fd, buf, 0, buf.length, readOffset);
        if (n != Math.min(buf.length, size)) throw Error('File read error!');
        let hash = crypto.createHash('md5').update(buf.subarray(0, n)).digest();
        globalHash.update(hash);
        chunks.push((new DataView(hash.buffer, hash.byteOffset).getInt32(0)));
        readOffset += n;
    }
    fs.closeSync(fd);
    let hash = globalHash.digest('binary');
    return [hash, chunks];
}

function walkDownDir(osPath, relPath) {
    relPath = relPath || '';
    for (let entryName of fs.readdirSync(osPath)) {
        let osEntryPath = `${osPath}/${entryName}`;
        let entryPath = relPath != '' ? `${relPath}/${entryName}` : entryName;
        if (!fileMatch(entryPath, entryName)) continue;
        let stat = fs.statSync(osEntryPath);
        if (stat.isDirectory()) {
            walkDownDir(osEntryPath, entryPath);
        } else if (stat.isFile()) {
            let file = {
                state: STATE.DELETED,
                downSize: stat.size,
            };
            let downChunkHash;
            [file.downFileHash, downChunkHash] = calcHashes(osEntryPath, stat.size);
            let fileIndex = Object.keys(fileMap.files).length;
            fileMap.files[entryPath] = file;
            fileMap.downFileHash[file.downFileHash] = entryPath;
            for (let hash of downChunkHash) {
                if (!(hash in fileMap.downChunkHash)) {
                    fileMap.downChunkHash[hash] = fileIndex;
                } else if (fileMap.downChunkHash[hash] instanceof Array) {
                    fileMap.downChunkHash[hash].push(fileIndex);
                } else {
                    fileMap.downChunkHash[hash] = [fileMap.downChunkHash[hash], fileIndex];
                }
            }
        }
    }
}

function walkUpDir(osPath, relPath) {
    relPath = relPath || '';
    for (let entryName of fs.readdirSync(osPath)) {
        let osEntryPath = `${osPath}/${entryName}`;
        let entryPath = relPath != '' ? `${relPath}/${entryName}` : entryName;
        if (!fileMatch(entryPath, entryName)) continue;
        let stat = fs.statSync(osEntryPath);
        if (stat.isDirectory()) {
            walkUpDir(osEntryPath, entryPath);
        } else if (stat.isFile()) {

            let file;
            if (entryPath in fileMap.files) {
                file = fileMap.files[entryPath];
                file.state = STATE.MODIFIED;
            } else {
                file = {
                    state: STATE.CREATED,
                };
                fileMap.files[entryPath] = file;
            }
            totalUpBytes += stat.size;
            file.upSize = stat.size;
            [file.upFileHash] = calcHashes(osEntryPath, stat.size);

            // Check if the same file on the same place: UNCHANGED
            if (file.downFileHash == file.upFileHash) {
                file.state = STATE.UNCHANGED;
                continue;
            }

            // Check if the same file on a different place: UNCHANGED + src
            if (file.upFileHash in fileMap.downFileHash) {
                file.state = STATE.UNCHANGED;
                file.src = fileMap.downFileHash[file.upFileHash];
                continue;
            }

            // Check if the same file copied: LINK
            if (file.upFileHash in fileMap.upFileHash) {
                file.state = STATE.LINK;
                file.src = fileMap.upFileHash[file.upFileHash];
                continue;
            }
            fileMap.upFileHash[file.upFileHash] = entryPath;
        }
    }
}

function compress(baseFile, inputFile) {
    let stat = fs.statSync(inputFile);
    let res;
    let args = [inputFile, '-'];
    if (baseFile) {
        args.push('-b');
        args.push(baseFile);
    }
    try {
        res = child_process.spawnSync('diff-brotli/build/linux/release/diffbrotli', args,
            {
                encoding: 'buffer',
                maxBuffer: Math.round(1.2 * stat.size) + 256
            });
    } catch (ex) {
        console.log('Cannot compress with "brotli" command. Make sure that "brotli" is on the PATH.');
        throw ex;
    }
    if (res.status !== 0) {
        console.log(res.stdout.toString('utf-8'));
        console.error(res.stderr.toString('utf-8'));
        throw Error(`"brotli" command returned status code ${res.status}.`);
    }
    if (res.stdout.length >= stat.size) {
        return fs.readFileSync(inputFile);
    } else {
        return res.stdout;
    }
}

let overlayFD = null;
let overlaySize = 0;
let overlayRoot = { '/d': 1 };

function addBlock(block) {
    let pos = overlaySize;
    fs.writeSync(overlayFD, block);
    overlaySize += block.length;
    return pos;
}

function getOverlayDir(pathArray) {
    let dir = overlayRoot;
    for (let i = 0; i < pathArray.length - 1; i++) {
        let name = pathArray[i];
        if (!(name in dir)) {
            dir[name] = { '/d': 1 };
        }
        dir = dir[name];
        if (!('/d' in dir)) {
            throw Error('Invalid file structure.');
        }
    }
    return dir;
}

function addToLayout(filePath, item) {
    pathArray = filePath.split('/');
    let dir = getOverlayDir(pathArray);
    let fileName = pathArray[pathArray.length - 1];
    dir[fileName] = item;
}

function createOverlay(osDownPath, osUpPath, overlayFile) {
    overlayFD = fs.openSync(overlayFile, 'w');
    fs.writeSync(overlayFD, new Uint8Array([0x4f, 0x76, 0x72, 0x6c]));
    overlaySize += 4;
    let totalInput = 0;
    let totalOutput = 0;
    for (filePath in fileMap.files) {
        let file = fileMap.files[filePath];
        let osDownFile = `${osDownPath}/${filePath}`;
        let osUpFile = `${osUpPath}/${filePath}`;
        let layout;
        if (file.upSize == 0) {
            layout = { s: 0, c: 0, b: 4 };
        } else if (file.state == STATE.DELETED) {
            layout = {};
        } else if (file.state == STATE.UNCHANGED) {
            if (file.src) {
                layout = {
                    f: file.src
                };
            } else {
                layout = null;
            }
            totalInput += file.upSize;
        } else if (file.state == STATE.LINK) {
            layout = fileMap.files[file.src].layout;
            if (layout.f == '') {
                layout = JSON.parse(JSON.stringify(layout));
                layout.f = file.src;
            }
            totalInput += file.upSize;
        } else {
            // Compress file directly
            let best = compress(null, osUpFile);
            let src = null;
            // If down file exists use as compression dictionary
            if (file.state == STATE.MODIFIED) {
                let next = compress(osDownFile, osUpFile);
                if (next.length < best.length) {
                    best = next;
                    src = filePath;
                }
            }
            // Search for best matching down file
            let fileIndexMap = Object.keys(fileMap.files);
            let matchCounter = {};
            let [_, upChunkHash] = calcHashes(osUpFile, file.upSize);
            for (let hash of upChunkHash) {
                if (hash in fileMap.downChunkHash) {
                    let list = fileMap.downChunkHash[hash];
                    if (!(list instanceof Array)) {
                        list = [list];
                    }
                    for (let p of list) {
                        p = fileIndexMap[p];
                        if (p in matchCounter) {
                            matchCounter[p]++;
                        } else {
                            matchCounter[p] = 1;
                        }
                    }
                }
            }
            let entries = Object.entries(matchCounter)
                .filter(x => x[0] != filePath)
                .sort((a, b) => (a[1] - b[1]));
            if (entries.length > 3) entries = entries.slice(0, 3);
            // If exists, use it as a compression dictionary
            let bestScore = best.length;
            for (let entry of entries) {
                let next = compress(`${osDownPath}/${entry[0]}`, osUpFile);
                if (next.length + entry[0].length * 0.6 < bestScore) {
                    best = next;
                    bestScore = next.length + entry[0].length * 0.6;
                    src = entry[0];
                }
            }
            // TODO: Call user-defined function to get base file hint and compare it with previous ones
            let begin = addBlock(best);
            layout = {
                s: file.upSize,
                b: begin,
            };
            if (src !== null) {
                layout.d = best.length;
                if (src != filePath) {
                    layout.f = src; // TODO: Allow reference to up file (requirement: up file is not referencing any other up file).
                }
            } else {
                layout.c = best.length;
            }
            totalOutput += best.length;
            totalInput += file.upSize;
        }
        file.layout = layout;
        if (layout)
            addToLayout(filePath, layout);
        //console.log(`Compression ${totalInput} -> ${totalOutput}: ${Math.round(totalOutput / totalInput * 1000) / 10}%`);
        //console.log(process.memoryUsage().heapTotal);
        process.stdout.write(`\r${Math.round(totalInput / totalUpBytes * 1000) / 10}%    `);
    }
    fileMap['/mimeTypes'] = {};
    let rootJSON = JSON.stringify(overlayRoot);
    fs.writeFileSync(overlayFile + '._file_map', rootJSON);
    let fileMapCompressed = compress(null, overlayFile + '._file_map');
    fs.unlinkSync(overlayFile + '._file_map');
    fs.writeSync(overlayFD, fileMapCompressed);
    totalOutput += fileMapCompressed.length;
    let footer = new Uint8Array(12);
    let footerView = new DataView(footer.buffer);
    footerView.setUint32(0, fileMapCompressed.length, true);
    footerView.setUint32(4, rootJSON.length, true);
    footerView.setUint32(8, 0x6c72764f, false);
    fs.writeSync(overlayFD, footer);
    totalOutput += footer.byteLength;
    fs.closeSync(overlayFD);
    console.log(`Compression ${totalInput} -> ${totalOutput}: ${Math.round(totalOutput / totalInput * 1000) / 10}%`);
}

walkDownDir('_.test/b/arch');
walkUpDir('_.test/a/arch');
console.log(process.memoryUsage().heapTotal);
createOverlay('_.test/b/arch', '_.test/a/arch', 'out.ovrl');

console.log(JSON.stringify(overlayRoot, null, 2));

//console.log('===================');
//console.log(JSON.stringify(fileMap, null, 4));
