
#include "brotli/encode.h"

#include <stdio.h>
#include <stdbool.h>
#include <string.h>

#include "common.h"

#ifndef WASM

static bool fillInput(FILE* fd, uint8_t* fileBuffer, uint32_t fileBufferSize, bool *hasMoreInput, size_t* availableIn, const uint8_t** nextIn)
{
    if (!*hasMoreInput) {
        TRACE("No more input\n");
        *availableIn = 0;
        *nextIn = fileBuffer;
    } else if (*availableIn == 0) {
        int n = fread(fileBuffer, 1, fileBufferSize, fd);
        if (n < 0) {
            ERR("File read error!\n");
            return false;
        }
        TRACE("Read %d bytes\n", n);
        *nextIn = fileBuffer;
        *availableIn = n;
        *hasMoreInput = n > 0;
    }
    return true;
}


bool encode(const char* baseFile, const char* inputFile, const char* outputFile)
{
    bool result = false;
    int n;
    uint32_t lgwin;
    long fileSize;
    uint32_t baseSize;
    uint32_t inputSize;
    FILE* baseFD = NULL;
    FILE* inputFD = NULL;
    FILE* outputFD = NULL;
    BrotliEncoderState *state = NULL;
    size_t availableOut;
    uint8_t *nextOut;
    size_t availableIn;
    const uint8_t *nextIn;
    size_t totalOut = 0;
    bool hasMoreInput;
    static uint8_t fileBuffer[128 * 1024];
    static uint8_t outputBuffer[128 * 1024];

    TRACE("Reading input file: %s\n", inputFile);
    inputFD = openInput(inputFile);
    if (!inputFD) {
        ERR("Cannot open input file '%s' for reading!\n", inputFile);
        goto error_exit;
    }
    fseek(inputFD, 0, SEEK_END);
    fileSize = ftell(inputFD);
    fseek(inputFD, 0, SEEK_SET);
    if (fileSize < 0 || fileSize > 512 * 1024 * 1024) {
        ERR("Input file read error!\n");
        goto error_exit;
    }
    inputSize = (uint32_t)fileSize;
    TRACE("Input file size: %d\n", inputSize);

    if (baseFile) {

        TRACE("Reading base file: %s\n", baseFile);
        baseFD = openInput(baseFile);
        if (!baseFD) {
            ERR("Cannot open base file '%s' for reading!\n", baseFile);
            goto error_exit;
        }
        fseek(baseFD, 0, SEEK_END);
        fileSize = ftell(baseFD);
        fseek(baseFD, 0, SEEK_SET);
        if (fileSize < 0 || fileSize > 512 * 1024 * 1024) {
            ERR("Base file read error!\n");
            goto error_exit;
        }
        baseSize = (uint32_t)fileSize;
        TRACE("Base file size: %d\n", baseSize);

        lgwin = BROTLI_MIN_WINDOW_BITS;
        do {
            uint32_t winSize = (1 << lgwin) - 16;
            if (winSize >= baseSize + inputSize) {
                break;
            }
            lgwin++;
        } while (lgwin < BROTLI_LARGE_MAX_WINDOW_BITS && lgwin < 30);
        TRACE("Minimum window size: %d\n", (1 << lgwin) - 16);

        state = BrotliEncoderCreateInstance(NULL, NULL, NULL);
        if (!state) {
            ERR("Cannot create Brotli encoder instance!\n");
            goto error_exit;
        }
        if (lgwin > BROTLI_MAX_WINDOW_BITS)
            BrotliEncoderSetParameter(state, BROTLI_PARAM_LARGE_WINDOW, 1);
        BrotliEncoderSetParameter(state, BROTLI_PARAM_QUALITY, BROTLI_MAX_QUALITY);
        BrotliEncoderSetParameter(state, BROTLI_PARAM_LGWIN, lgwin);
        BrotliEncoderSetParameter(state, BROTLI_PARAM_SIZE_HINT, baseSize + inputSize);

        hasMoreInput = true;
        availableOut = sizeof(outputBuffer);
        nextOut = outputBuffer;
        availableIn = 0;
        nextIn = outputBuffer;

        do {
            if (!fillInput(baseFD, fileBuffer, sizeof(fileBuffer), &hasMoreInput, &availableIn, &nextIn))
                goto error_exit;
            TRACE_ONLY_VAR uint8_t* oldNextOut = nextOut;
            TRACE_ONLY_VAR const uint8_t* oldNextIn = nextIn;
            BROTLI_BOOL ok = BrotliEncoderCompressStream(state,
                hasMoreInput ? BROTLI_OPERATION_PROCESS : BROTLI_OPERATION_FLUSH,
                &availableIn, &nextIn, &availableOut, &nextOut, &totalOut);
            TRACE("Load base %sing %d -> %d\n", hasMoreInput ? "process" : "flush",
                (int)(nextIn - oldNextIn), (int)(nextOut - oldNextOut));
            if (ok == BROTLI_FALSE) {
                ERR("Brotli compression error!\n");
                goto error_exit;
            }
            if (nextOut != &outputBuffer[0] && nextOut != &outputBuffer[1]) {
                availableOut = sizeof(outputBuffer - 2);
                nextOut = &outputBuffer[2];
            }
        } while (hasMoreInput || BrotliEncoderHasMoreOutput(state) != BROTLI_FALSE);

        closeInput(baseFD);
        baseFD = NULL;

    } else {
        
        lgwin = BROTLI_MIN_WINDOW_BITS;
        do {
            uint32_t winSize = (1 << lgwin) - 16;
            if (winSize >= inputSize) {
                break;
            }
            lgwin++;
        } while (lgwin < BROTLI_MAX_WINDOW_BITS);
        TRACE("Window size: %d\n", (1 << lgwin) - 16);

        state = BrotliEncoderCreateInstance(NULL, NULL, NULL);
        if (!state) {
            ERR("Cannot create Brotli encoder instance!\n");
            goto error_exit;
        }
        BrotliEncoderSetParameter(state, BROTLI_PARAM_QUALITY, BROTLI_MAX_QUALITY);
        BrotliEncoderSetParameter(state, BROTLI_PARAM_LGWIN, lgwin);
        BrotliEncoderSetParameter(state, BROTLI_PARAM_SIZE_HINT, inputSize);
    }

    TRACE("Writing output file: %s\n", outputFile);
    outputFD = openOutput(outputFile);
    if (!outputFD) {
        ERR("Cannot open output file '%s' for writing!\n", outputFile);
        goto error_exit;
    }

    if (baseFile) {
        if (outputBuffer[0] == 0x11) {
            outputBuffer[2] = 0x80 | (outputBuffer[1] & 0x3F);
        } else {
            outputBuffer[2] = outputBuffer[0] & 0x7F;
        }

        TRACE("Writing modified header 0x%02X 0x%02X -> 0x%02X\n", outputBuffer[0], outputBuffer[1], outputBuffer[2]);
        n = fwrite(&outputBuffer[2], 1, 1, outputFD);
        if (n != 1) {
            ERR("Cannot write to output file!\n");
            goto error_exit;
        }
    }

    hasMoreInput = true;
    availableOut = sizeof(outputBuffer);
    nextOut = outputBuffer;
    availableIn = 0;
    nextIn = outputBuffer;

    do {
        if (!fillInput(inputFD, fileBuffer, sizeof(fileBuffer), &hasMoreInput, &availableIn, &nextIn))
            goto error_exit;
        TRACE_ONLY_VAR uint8_t* oldNextOut = nextOut;
        TRACE_ONLY_VAR const uint8_t* oldNextIn = nextIn;
        BROTLI_BOOL ok = BrotliEncoderCompressStream(state,
            hasMoreInput ? BROTLI_OPERATION_PROCESS : BROTLI_OPERATION_FINISH,
            &availableIn, &nextIn, &availableOut, &nextOut, &totalOut);
        TRACE("Compression %sing %d -> %d\n", hasMoreInput ? "process" : "finish",
            (int)(nextIn - oldNextIn),(int)(nextOut - oldNextOut));
        if (ok == BROTLI_FALSE) {
            ERR("Brotli compression error!\n");
            goto error_exit;
        }
        if (nextOut != outputBuffer) {
            uint32_t size = nextOut - outputBuffer;
            TRACE("Write %d bytes\n", size);
            n = fwrite(outputBuffer, 1, size, outputFD);
            if (n != size) {
                ERR("Cannot write to output file!\n");
                goto error_exit;
            }
            availableOut = sizeof(outputBuffer);
            nextOut = outputBuffer;
        }
    } while (hasMoreInput || BrotliEncoderHasMoreOutput(state) != BROTLI_FALSE);

    result = true;

error_exit:
    closeInput(baseFD);
    closeInput(inputFD);
    closeOutput(outputFD);
    if (state) BrotliEncoderDestroyInstance(state);
    return result;
}

#endif // WASM
