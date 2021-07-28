const brotli = require('brotli');

function brotliDecompress(input, outputSize)
{
    return brotli.decompress(input, outputSize);
}

self.brotliDecompress = brotliDecompress;
