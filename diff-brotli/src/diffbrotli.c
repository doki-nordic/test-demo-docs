
#include <string.h>
#include <stdint.h>
#include <stdlib.h>

#include "common.h"

#ifndef WASM

bool decodeFile(const char* baseFile, const char* inputFile, const char* outputFile, uint32_t outputSize)
{
    int n;
    bool result = false;
    FILE* baseFD = NULL;
    FILE* inputFD = openInput(inputFile);
    FILE* outputFD = openOutput(outputFile);
    long inputSize = 0;
    long baseSize = 0;

    if (baseFile) {
        baseFD = openInput(baseFile);
        if (!baseFD) {
            ERR("Cannot open base file!\n");
            goto error_exit;
        }
    }

    if (!inputFD || !outputFD) {
        ERR("Cannot open file!\n");
        goto error_exit;
    }

    fseek(inputFD, 0, SEEK_END);
    inputSize = ftell(inputFD);
    fseek(inputFD, 0, SEEK_SET);

    if (baseFD) {
        fseek(baseFD, 0, SEEK_END);
        baseSize = ftell(baseFD);
        fseek(baseFD, 0, SEEK_SET);
    }

    if (baseSize < 0 || inputSize < 0) {
        ERR("Cannot read from file!\n");
        goto error_exit;
    }

    DecInstance* state = decodeBegin(baseSize, inputSize, outputSize);

    if (baseFD) {
        n = fread(state->base, 1, baseSize, baseFD);
        if (n != baseSize) {
            ERR("Cannot read from base file!\n");
            goto error_exit;
        }
    }

    n = fread(state->input, 1, inputSize, inputFD);
    if (n != inputSize) {
        ERR("Cannot read from input file!\n");
        goto error_exit;
    }

    outputSize = decode(baseSize, inputSize, outputSize);

    if (outputSize == DECODE_ERROR_RESULT) {
        ERR("Cannot decompress!\n");
        goto error_exit;
    }

    n = fwrite(state->output, 1, outputSize, outputFD);
    if (n != outputSize) {
        ERR("Cannot write to output file!\n");
        goto error_exit;
    }

    decodeEnd();

error_exit:
    closeInput(baseFD);
    closeInput(inputFD);
    closeOutput(outputFD);
    return result;
}


int usage(const char* prog) {
    printf(
        "USAGE:\n"
        "    %s [options] INPUT_FILE OUTPUT_FILE\n"
        "\n"
        "Options:\n"
        "    -b BASE_FILE    Base file for differential encoding/decoding.\n"
        "    -d OUTPUT_SIZE  Decode. OUTPUT_SIZE is maximum output file size.\n"
        "    -e              Encode (default).\n"
        "\n"
        "Pass \"-\" to INPUT_FILE or BASE_FILE to read from standard input.\n"
        "Pass \"-\" to OUTPUT_FILE to write output to standard output.\n", prog);
    return 10;
}


int main(int argc, char *argv[])
{
    bool decode = false;
    const char* baseFile = NULL;
    const char* inputFile = NULL;
    const char* outputFile = NULL;
    uint32_t outputSize = 0;
    int i;
    for (i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-b") == 0) {
            if (i == argc - 1) return usage(argv[0]);
            i++;
            baseFile = argv[i];
        } else if (strcmp(argv[i], "-d") == 0) {
            if (i == argc - 1) return usage(argv[0]);
            i++;
            outputSize = atoi(argv[i]);
            if (outputSize == 0 || outputSize > 512 * 1024 * 1024) return usage(argv[0]);
            decode = true;
        } else if (strcmp(argv[i], "-e") == 0) {
            decode = false;
        } else if (inputFile && outputFile) {
            return usage(argv[0]);
        } else if (inputFile) {
            outputFile = argv[i];
        } else {
            inputFile = argv[i];
        }
    }

    if (!inputFile || !outputFile) return usage(argv[0]);

    if (decode) {
        return decodeFile(baseFile, inputFile, outputFile, outputSize) ? 0 : 1;
    } else {
        return encode(baseFile, inputFile, outputFile) ? 0 : 1;
    }
}

#endif // WASM
