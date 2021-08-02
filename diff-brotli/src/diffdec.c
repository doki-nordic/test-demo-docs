
#include <malloc.h>
#include <stdbool.h>

#include "brotli/decode.h"

#include "common.h"


static uint8_t *base;
static uint8_t *input;
static uint8_t *output;
static uint32_t currentBaseSize;
static uint32_t currentInputSize;
static uint32_t currentOutputSize;

static uint64_t header;
static int headerBits;

static BrotliDecoderState* state = NULL;
size_t totalOut = 0;


#ifdef WASM
#define WASM_EXPORT(name) __attribute__((used)) __attribute__((export_name(#name)))
#else
#define WASM_EXPORT(name)
#endif


static inline bool reallocBuffer(uint8_t** buffer, uint32_t *size, uint32_t newSize)
{
    if (newSize < 256) {
        newSize = 256;
    }

    if (!*buffer) {
        *buffer = malloc(newSize);
        *size = newSize;
    } else if (*size < newSize) {
        free(*buffer);
        *buffer = malloc(newSize);
        *size = newSize;
    }

    return !!*buffer;
}


WASM_EXPORT(decodeBegin)
DecInstance* decodeBegin(uint32_t baseSize, uint32_t inputSize, uint32_t outputSize)
{
    bool ok;
    ok = reallocBuffer(&input, &currentInputSize, inputSize);
    ok = ok && reallocBuffer(&output, &currentOutputSize, outputSize);
    if (baseSize > 0) {
        ok = ok && reallocBuffer(&base, &currentBaseSize, baseSize);
    }
    if (ok) {
        static DecInstance instance;
        instance.base = base;
        instance.input = input;
        instance.output = output;
        return &instance;
    } else {
        return NULL;
    }
}


WASM_EXPORT(decodeEnd)
void decodeEnd()
{
    if (base) free(base);
    base = NULL;
    if (input) free(input);
    input = NULL;
    if (output) free(output);
    output = NULL;
    if (state) BrotliDecoderDestroyInstance(state);
    state = NULL;
}


static inline void putBits(uint32_t value, int bits) {
    value &= (1 << bits) - 1;
    header |= (uint64_t)value << headerBits;
    headerBits += bits;
}


static bool feedBaseData(const uint8_t* data, uint32_t size)
{

    size_t availableOut;
    uint8_t *nextOut;
    size_t availableIn;
    const uint8_t *nextIn;
    BrotliDecoderResult res;

    nextIn = data;
    availableIn = size;

    while (availableIn > 0 || BrotliDecoderHasMoreOutput(state)) {
        availableOut = currentOutputSize;
        nextOut = output;
        res = BrotliDecoderDecompressStream(state, &availableIn, &nextIn, &availableOut, &nextOut, &totalOut);
        if (res == BROTLI_DECODER_RESULT_ERROR) {
            TRACE("Brotli decoder error!\n");
            return false;
        } else {
            TRACE("Load base %d -> %d\n", (int)(nextIn - data), (int)(nextOut - output));
        }
    }

    return true;
}


static int feedBaseBlock(uint32_t offset, uint32_t size)
{
    putBits(0, 1); // ISLAST
    if (size <= 0x10000) {
        putBits(0, 2); // MNIBBLES
        putBits(size - 1, 16); // MLEN - 1
    } else if (size <= 0x100000) {
        putBits(1, 2); // MNIBBLES
        putBits(size - 1, 20); // MLEN - 1
    } else {
        putBits(2, 2); // MNIBBLES
        if (size > 0x1000000)
            size = 0x1000000;
        putBits(size - 1, 24); // MLEN - 1
    }
    putBits(1, 1); // ISUNCOMPRESSED
    if (!feedBaseData((uint8_t*)&header, (headerBits + 7) / 8))
        return -1;
    if (!feedBaseData(&base[offset], size))
        return -1;
    header = 0;
    headerBits = 0;
    return size;
}


static int decompressInput(uint32_t inputSize, uint32_t outputSize)
{
    size_t availableOut = outputSize;
    uint8_t *nextOut = output;
    size_t availableIn = inputSize - 1;
    const uint8_t *nextIn = input + 1;
    BrotliDecoderResult res;

    res = BrotliDecoderDecompressStream(state, &availableIn, &nextIn, &availableOut, &nextOut, &totalOut);
    switch (res)
    {
    default:
    case BROTLI_DECODER_RESULT_ERROR:
        TRACE("Brotli decoder error!\n");
        return -1;
    case BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT:
        TRACE("Truncated input!\n");
        return -1;
    case BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT:
        TRACE("Output size too small!\n");
        return -1;
    case BROTLI_DECODER_RESULT_SUCCESS:
        TRACE("Decompress data %d -> %d\n", (int)(nextIn - input - 1), (int)(nextOut - output));
        break;
    }

    return (int)(nextOut - output);
}


WASM_EXPORT(decode)
uint32_t decode(uint32_t baseSize, uint32_t inputSize, uint32_t outputSize)
{
    uint32_t offset;
    int n;

    if (!input || !output) {
        TRACE("Decoding not started correctly.\n");
        return DECODE_ERROR_RESULT;
    }

    totalOut = 0;

    if (state) {
        BrotliDecoderDestroyInstance(state);
        state = NULL;
    }

    if (baseSize > 0) {
        if (!base) {
            TRACE("Decoding not started correctly.\n");
            return DECODE_ERROR_RESULT;
        }

        state = BrotliDecoderCreateInstance(NULL, NULL, NULL);
        if (!state) {
            TRACE("Cannot create decoder instance!\n");
            return DECODE_ERROR_RESULT;
        }

        headerBits = 0;
        if (input[0] & 0x80) {
            putBits(0x11, 8); // large window brotli stream
            putBits(input[0] & 0x3F, 6); // WBITS
            BrotliDecoderSetParameter(state, BROTLI_DECODER_PARAM_LARGE_WINDOW, 1);
        } else if ((input[0] & 1) == 0) {
            putBits(0, 1); // WBITS
        } else if ((input[0] & 0x0F) == 0x01) {
            putBits(input[0], 7); // WBITS
        } else {
            putBits(input[0], 4); // WBITS
        }

        offset = 0;
        while (offset < baseSize) {
            n = feedBaseBlock(offset, baseSize - offset);
            if (n <= 0) return DECODE_ERROR_RESULT;
            offset += n;
        }

        n = decompressInput(inputSize, outputSize);
        if (n < 0) {
            return DECODE_ERROR_RESULT;
        }

        BrotliDecoderDestroyInstance(state);
        state = NULL;

        return n;

    } else {

        size_t os = outputSize;
        BrotliDecoderResult res = BrotliDecoderDecompress(inputSize, input, &os, output);

        switch (res)
        {
        default:
        case BROTLI_DECODER_RESULT_ERROR:
            TRACE("Brotli decoder error!\n");
            return DECODE_ERROR_RESULT;
        case BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT:
            TRACE("Truncated input!\n");
            return DECODE_ERROR_RESULT;
        case BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT:
            TRACE("Output size too small!\n");
            return DECODE_ERROR_RESULT;
        case BROTLI_DECODER_RESULT_SUCCESS:
            TRACE("Decompress data %d -> %d\n", inputSize, (int)os);
            return os;
        }

        return DECODE_ERROR_RESULT;
    }
}

