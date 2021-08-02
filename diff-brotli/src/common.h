
#include <stdio.h>
#include <string.h>
#include <stdbool.h>

#ifdef DEBUG
#define TRACE(...) fprintf(stderr, ##__VA_ARGS__)
#define TRACE_ONLY_VAR
#else
#define TRACE(...) do { } while (0)
#define TRACE_ONLY_VAR __attribute__((unused))
#endif

#define ERR(...) fprintf(stderr, ##__VA_ARGS__)

#define DECODE_ERROR_RESULT 0xFFFFFFFFuL

bool encode(const char* baseFile, const char* inputFile, const char* outputFile);

typedef struct
{
    uint8_t *base;
    uint8_t *input;
    uint8_t *output;
} DecInstance;

DecInstance* decodeBegin(uint32_t baseSize, uint32_t inputSize, uint32_t outputSize);
void decodeEnd();
uint32_t decode(uint32_t baseSize, uint32_t inputSize, uint32_t outputSize);

static inline FILE* openInput(const char* path)
{
    if (strcmp(path, "-") == 0) {
        return stdin;
    } else {
        return fopen(path, "rb");
    }
}

static inline void closeInput(FILE* f) {
    if (f != NULL && f != stdin) fclose(f);
}


static inline FILE* openOutput(const char* path)
{
    if (strcmp(path, "-") == 0) {
        return stdout;
    } else {
        return fopen(path, "wb");
    }
}

static inline void closeOutput(FILE* f) {
    if (f != NULL && f != stdout) fclose(f);
}
