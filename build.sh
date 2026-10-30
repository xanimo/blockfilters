#!/usr/bin/env bash
# Builds payment-channel's core and koinu's crypto to wasm.
#
# Needs emscripten on PATH and a payment-channel checkout with its koinu
# submodule initialised. secp256k1 is exported from that submodule with
# git archive rather than copied: a copied tree keeps the native objects from
# an earlier build, make sees them as current, and the archive ends up ELF
# while everything else is wasm. The link then fails on every secp symbol.
set -euo pipefail

PC=${PC:-../payment-channel}
R=$(cd "$(dirname "$0")" && pwd)
K="$PC/depends/koinu"

command -v emcc >/dev/null || { echo "emcc not on PATH; source emsdk_env.sh" >&2; exit 1; }
[ -f "$K/crypto/psbt.c" ] || { echo "no koinu at $K; set PC= to a payment-channel checkout" >&2; exit 1; }

# secp256k1, from a pristine export
if [ ! -f "$R/secp256k1-wasm/.libs/libsecp256k1.a" ]; then
    rm -rf "$R/secp256k1-wasm"; mkdir -p "$R/secp256k1-wasm"
    git -C "$K/depends/secp256k1" archive HEAD | tar -x -C "$R/secp256k1-wasm"
    cd "$R/secp256k1-wasm"
    ./autogen.sh
    emconfigure ./configure --enable-static --disable-shared --disable-tests \
        --disable-exhaustive-tests --disable-benchmark --host=none-none-none
    emmake make -j"$(nproc)"
    cd "$R"
fi

# 4MB of stack because pc_envelope carries a 16KB psbt field and emscripten
# defaults to 64KB, which faults inside open_create rather than anywhere
# obvious.
emcc -std=gnu99 -O2 \
    -I"$PC/include" -I"$PC/src" -I"$K/crypto" -I"$K/wallet" -I"$R/secp256k1-wasm/include" \
    "$R/src/pcwasm.c" \
    "$PC"/src/{channel,txcheck,envelope,state}.c \
    "$K"/crypto/{tx,psbt,ec,address,base58,sha2,sha2_hw,ripemd160,hex,rng,chainparams,mem,cpu}.c \
    "$R/secp256k1-wasm/.libs/libsecp256k1.a" \
    -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString \
    -sALLOW_MEMORY_GROWTH=1 -sMODULARIZE=1 -sEXPORT_NAME=PC -sSTACK_SIZE=4MB \
    -o "$R/demo/pc.js"

echo "built demo/pc.wasm $(stat -c%s "$R/demo/pc.wasm") bytes"
echo "check it with: node build/smoke.js   (needs node 18+, emsdk ships one)"
