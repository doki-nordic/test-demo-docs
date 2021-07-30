const fs = require('fs');
const child_process = require('child_process');
const process = require('process');
const crypto = require('crypto');

let outputFile = process.argv[2];
let inputDir = process.argv[3];
let mimeTypesFile = process.argv[4];
let hashMap = {};
let extMap = {};

let totalInput = 0;

function compress(file) {
    let stat = fs.statSync(file);
    let res;
    if (true) {
        let w;
        for (w = 10; w < 20; w++) {
            let windowSize = (1 << w) - 16;
            if (windowSize >= stat.size) {
                break;
            }
        }
        let args = ['-cn9w', w.toString(), `${file}`];
        try {
            res = child_process.spawnSync('brotli', args,
                {
                    encoding: 'buffer',
                    maxBuffer: Math.round(1.2 * stat.size) + 256
                });
        } catch (ex) {
            console.log('Cannot compress with "brotli" command. Make sure that "brotli" is on the PATH.');
            throw ex;
        }
    } else {
        let w;
        for (w = 1; w < 9; w++) {
            let windowSize = w * 100000;
            if (windowSize >= stat.size) {
                break;
            }
        }
        let args = ['-zkc', '-' + w, `${file}`];
        try {
            res = child_process.spawnSync('bzip2', args,
                {
                    encoding: 'buffer',
                    maxBuffer: Math.round(1.2 * stat.size) + 1024
                });
        } catch (ex) {
            console.log('Cannot compress with "bzip2" command. Make sure that "bzip2" is on the PATH.');
            throw ex;
        }
    }
    if (res.status !== 0) {
        console.log(res.stdout.toString('utf-8'));
        console.error(res.stderr.toString('utf-8'));
        throw Error(`"brotli" command returned status code ${res.status}.`);
    }
    if (res.stdout.length >= stat.size) {
        let output = fs.readFileSync(file, 'binary');
        console.log(`File ${file} incompressible: ${output.length} => ${output.length} (100%)`);
        totalInput += output.length;
        return {
            size: output.length,
            content: output
        };
    }
    console.log(`File ${file} compressed: ${stat.size} => ${res.stdout.length} (${Math.round(res.stdout.length / stat.size * 1000) / 10}%)`);
    totalInput += stat.size;
    return {
        size: stat.size,
        content: res.stdout
    };
}

function processDir(dirPath, dirItem) {
    for (let file of fs.readdirSync(dirPath)) {
        if (file == '..' || file == '.') continue;
        let path = `${dirPath}/${file}`;
        let stat = fs.statSync(path);
        let item;
        if (stat.isDirectory()) {
            item = {
                '/d': 1,
            }
            processDir(path, item);
        } else {
            let extPos = file.lastIndexOf('.');
            if (extPos > 0) {
                let ext = file.substr(extPos).toLowerCase();
                extMap[ext] = true;
            }
            let hash = crypto.createHash('sha256').update(fs.readFileSync(path)).digest('base64');
            if (hash in hashMap) {
                item = hashMap[hash];
                console.log(`File ${path} reused: ${item.s} => 0 (0%)`);
                totalInput += item.s;
            } else {
                let out = compress(path);
                let begin = outputSize;
                fs.writeSync(outputFD, out.content);
                outputSize += out.content.length;
                item = {
                    s: out.size,
                    b: begin,
                    c: out.content.length,
                }
                hashMap[hash] = item;
            }
        }
        dirItem[file] = item;
    }
}

let outputFD = fs.openSync(outputFile, 'w');
fs.writeSync(outputFD, new Uint8Array([0x4f, 0x76, 0x72, 0x6c]));
let outputSize = 4;
let fileMap = {'/d':1};

processDir(inputDir, fileMap);

fileMap['/mimeTypes'] = JSON.parse(fs.readFileSync(mimeTypesFile, 'utf-8'));

for (let ext in fileMap['/mimeTypes']) {
    delete extMap[ext];
}

fs.writeFileSync(outputFile + '._file_map', JSON.stringify(fileMap));
let fileMapCompressed = compress(outputFile + '._file_map');
fs.unlinkSync(outputFile + '._file_map');
fs.writeSync(outputFD, fileMapCompressed.content);
outputSize += fileMapCompressed.content.length;
let footer = new Uint8Array(12);
let footerView = new DataView(footer.buffer);
footerView.setUint32(0, fileMapCompressed.content.length, true);
footerView.setUint32(4, fileMapCompressed.size, true);
footerView.setUint32(8, 0x6c72764f, false);
fs.writeSync(outputFD, footer);
outputSize += footer.byteLength;
fs.closeSync(outputFD);

console.log(`Total compression: ${totalInput} => ${outputSize} (${Math.round(outputSize / totalInput * 1000) / 10}%)`);

for (let ext in extMap) {
    console.log(`Warning: No MIME type for ${ext}`);
}
