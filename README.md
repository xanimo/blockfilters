# blockfilters

the site arguing that dogecoin core should serve bip157/158, with
payment-channel's c compiled to wasm so the argument contains something
running rather than a description of something running.

two pages. `index.html` is the case and the measurements. `demo/` is the
channel itself, kept separate so the landing page does not pull 1.4mb of wasm
to be read.

## what is real on the demo page

`demo/pc.wasm` is payment-channel's `channel.c`, `txcheck.c`, `envelope.c` and
`state.c` plus koinu's crypto, linked against libsecp256k1. keys are generated
in the tab, the signatures are real ecdsa, and the transactions are serialized
by the same code the daemon broadcasts. `demo/app.js` decides what to call and
in what order and computes nothing itself.

what the page cannot do is reach a chain, which is the argument: the funding
transaction is built locally the way `test/mkfunding` builds it, and whether it
was mined is exactly what `--confirm-cmd` exists to ask.

## building

needs emscripten and a payment-channel checkout with its koinu submodule
initialised.

    source /path/to/emsdk/emsdk_env.sh
    PC=../payment-channel ./build.sh
    node build/smoke.js          # needs node 18+, emsdk ships one

`build.sh` exports secp256k1 out of the submodule with `git archive` rather
than copying it. a copied tree keeps the native objects from an earlier build,
make sees them as current, and the archive ends up elf while everything else is
wasm, so the link fails on every secp symbol with nothing pointing at why.

the stack is set to 4mb. `pc_envelope` carries a 16kb psbt field and emscripten
defaults to 64kb, which faults inside `pc_channel_open_create` rather than
anywhere that names the cause.

`demo/pc.js` and `demo/pc.wasm` are committed so pages serves them with no
build step. rebuild whenever payment-channel or its koinu pin moves.

## hosting

github pages, with `.nojekyll` so nothing is filtered. every path is relative,
so it works at a user page, a project page or a custom domain with no changes.

the site is koin.ooo, which is what `CNAME` holds. the dns side is an ALIAS or
four A records at the apex:

    185.199.108.153
    185.199.109.153
    185.199.110.153
    185.199.111.153

enforce https once github has issued the certificate.

## the numbers

measured by the koinu author on mainnet, quoted with permission. the serving
node is identified as "one node" deliberately and no address appears anywhere
in the repo. the filter counts and byte totals are exact; the sync time is one
run on one machine.

## checking it

    node build/smoke.js

drives the same calls the page makes and prints what the c returned: a channel
address, a funding outpoint, three countersigned payments, a replayed payment
refused by the ratchet, and a refund. the pages themselves are checked by
clicking their own buttons in headless chrome.
