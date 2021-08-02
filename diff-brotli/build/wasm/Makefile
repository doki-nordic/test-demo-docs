
CC=$(WASI_SDK_ROOT)/bin/clang --sysroot=$(WASI_SDK_ROOT)/share/wasi-sysroot
STRIP=$(WASI_SDK_ROOT)/bin/llvm-strip
TARGET=diffbrotli.wasm
CFLAGS=-DWASM -Wall
LDFLAGS=-Wl,--no-entry -nostartfiles -Wl,--import-memory -mexec-model=reactor -z stack-size=262144
OPTFLAGS=-Oz -g0 -flto
DEBUGFLAGS=-O0 -g

include ../Makefile.common

ifneq (1,$(DEBUG))
  POST_DEP=$(OUTDIR)/obj/$(TARGET)-unopt.wasm
endif
postprocess: $(POST_DEP)

$(OUTDIR)/obj/$(TARGET)-unopt.wasm: $(OUTDIR)/$(TARGET)
	cp $(OUTDIR)/$(TARGET) $(OUTDIR)/obj/$(TARGET)-unopt.wasm
	$(BINARYEN_ROOT)/bin/wasm-opt -Oz -o $(OUTDIR)/$(TARGET) $(OUTDIR)/obj/$(TARGET)-unopt.wasm
	touch $(OUTDIR)/obj/$(TARGET)-unopt.wasm
