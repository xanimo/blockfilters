/* The browser face of payment-channel.
 *
 * Every function here is the same call the alice and bob binaries make. No
 * logic is reimplemented in JavaScript: the page drives this, and what it
 * prints is what the C produced. Strings come back malloc'd and the caller
 * frees them through pcw_free.
 *
 * The one thing a browser cannot have is a chain. The funding transaction is
 * built the way test/mkfunding builds it, a real serialization with a dummy
 * input, so the txid, the script and the sighash are all computed over real
 * bytes. Whether that transaction is on a chain is exactly the question
 * --confirm-cmd exists to ask, and the page asks it out of band.
 */
#include "channel.h"
#include "hex.h"
#include "ec.h"
#include "tx.h"
#include "address.h"
#include "base58.h"
#include "rng.h"

#include <emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define KEEP EMSCRIPTEN_KEEPALIVE

/* One buffer per call, handed to JS and freed by it. */
static char *dup_str(const char *s)
{
    size_t n = strlen(s) + 1;
    char *o = (char *)malloc(n);
    if (o) memcpy(o, s, n);
    return o;
}

static char *errf(const char *what, pc_result r)
{
    char buf[256];
    snprintf(buf, sizeof(buf), "{\"err\":\"%s\",\"why\":\"%s\"}", what, pc_strerror(r));
    return dup_str(buf);
}

void KEEP pcw_free(char *p) { free(p); }

void KEEP pcw_start(void) { kw_ec_start(); }
void KEEP pcw_stop(void)  { kw_ec_stop(); }

/* A keypair on (chain): wif, pubkey and the p2pkh address that pays it. */
char * KEEP pcw_keypair(int chain)
{
    const kw_chainparams *cp = pc_chainparams((pc_chain)chain);
    uint8_t sk[32], pub[33];
    char wif[PRIVKEYWIFLEN], addr[P2PKHLEN], pubhex[67], out[512];

    if (!kw_random_bytes(sk, sizeof(sk)) || !kw_ec_pubkey(sk, pub))
        return dup_str("{\"err\":\"keygen\"}");
    if (!kw_wif_encode(sk, 1, cp->wif, wif, sizeof(wif)) ||
        !kw_address_p2pkh(pub, cp->p2pkh, addr, sizeof(addr)))
        return dup_str("{\"err\":\"encode\"}");
    pc_bin_to_hex(pub, 33, pubhex);
    { volatile uint8_t *z = sk; for (int i = 0; i < 32; i++) z[i] = 0; }

    snprintf(out, sizeof(out), "{\"wif\":\"%s\",\"pub\":\"%s\",\"addr\":\"%s\"}",
             wif, pubhex, addr);
    return dup_str(out);
}

/* The channel: the 2-of-2 with a CLTV refund branch, and the p2sh it pays. */
char * KEEP pcw_channel(const char *alice_pub, const char *bob_pub,
                        unsigned locktime, int chain)
{
    pc_channel ch;
    pc_result r = pc_channel_init(&ch, alice_pub, bob_pub, locktime, (pc_chain)chain);
    if (r != PC_OK) return errf("channel_init", r);

    char *out = (char *)malloc(PC_MAX_SCRIPT_HEX + 512);
    if (!out) return dup_str("{\"err\":\"oom\"}");
    sprintf(out, "{\"addr\":\"%s\",\"redeem\":\"%s\",\"locktime\":%u}",
            ch.p2sh_address, ch.redeem_script_hex, locktime);
    return out;
}

/* A funding transaction paying (addr) the given koinu, as test/mkfunding
 * builds it: one dummy input, the channel output first, a token change
 * output. Real bytes, real txid, never broadcast. */
char * KEEP pcw_funding(const char *p2sh, const char *change, const char *doge)
{
    uint64_t koinu = 0;
    if (pc_doge_to_koinu(doge, &koinu) != PC_OK) return dup_str("{\"err\":\"amount\"}");

    uint8_t praw[64], craw[64];
    size_t pn = 0, cn = 0;
    if (!kw_base58check_decode(p2sh, praw, sizeof(praw), &pn) || pn != 21 ||
        !kw_base58check_decode(change, craw, sizeof(craw), &cn) || cn != 21)
        return dup_str("{\"err\":\"address\"}");

    uint8_t spk[23];
    spk[0] = 0xa9; spk[1] = 0x14; memcpy(spk + 2, praw + 1, 20); spk[22] = 0x87;

    kw_tx tx;
    kw_tx_init(&tx);
    if (!kw_tx_add_input(&tx,
            "b4455e7b7b7acb51fb6feba7a2702c42a5100f61f61abafa31851ed6ae076074", 0) ||
        !kw_tx_add_output(&tx, koinu, spk, sizeof(spk)) ||
        !kw_tx_add_output_p2pkh(&tx, 100000000ULL, craw + 1))
        return dup_str("{\"err\":\"build\"}");

    uint8_t raw[8192];
    size_t n = kw_tx_serialize(&tx, raw, sizeof(raw));
    if (n == 0) return dup_str("{\"err\":\"serialize\"}");

    uint8_t txid[32], rev[32];
    if (!kw_tx_txid(&tx, txid)) return dup_str("{\"err\":\"txid\"}");
    for (int i = 0; i < 32; i++) rev[i] = txid[31 - i];

    char txid_hex[65];
    pc_bin_to_hex(rev, 32, txid_hex);
    char *hex = (char *)malloc(n * 2 + 1);
    if (!hex) return dup_str("{\"err\":\"oom\"}");
    pc_bin_to_hex(raw, n, hex);

    char *out = (char *)malloc(n * 2 + 256);
    if (!out) { free(hex); return dup_str("{\"err\":\"oom\"}"); }
    sprintf(out, "{\"tx\":\"%s\",\"txid\":\"%s\",\"vout\":0}", hex, txid_hex);
    free(hex);
    return out;
}

/* Alice's opening PSBT: one input spending the funding output, no outputs. */
char * KEEP pcw_open_create(const char *alice_pub, const char *bob_pub,
                            unsigned locktime, int chain, const char *funding_tx)
{
    pc_channel ch;
    pc_result r = pc_channel_init(&ch, alice_pub, bob_pub, locktime, (pc_chain)chain);
    if (r != PC_OK) return errf("channel_init", r);

    char *psbt = NULL;
    r = pc_channel_open_create(&ch, funding_tx, &psbt);
    if (r != PC_OK) return errf("open_create", r);

    char *out = (char *)malloc(strlen(psbt) + 64);
    if (!out) { free(psbt); return dup_str("{\"err\":\"oom\"}"); }
    sprintf(out, "{\"psbt\":\"%s\"}", psbt);
    free(psbt);
    return out;
}

/* Bob's side of the open. He computes the redeem from his own key, works the
 * outpoint out of the funding transaction and refuses anything that does not
 * match. This is the call that decides whether a channel exists. */
char * KEEP pcw_open_accept(const char *alice_pub, const char *bob_pub,
                            unsigned locktime, int chain,
                            const char *psbt, const char *funding_tx,
                            unsigned height, unsigned slack)
{
    pc_channel ch;
    pc_result r = pc_channel_init(&ch, alice_pub, bob_pub, locktime, (pc_chain)chain);
    if (r != PC_OK) return errf("channel_init", r);

    uint64_t cap = 0;
    r = pc_channel_open_accept(&ch, psbt, funding_tx, height, slack, &cap);
    if (r != PC_OK) return errf("open_accept", r);

    char out[512];
    snprintf(out, sizeof(out),
             "{\"capacity\":%llu,\"txid\":\"%s\",\"vout\":%d,\"addr\":\"%s\"}",
             (unsigned long long)cap, ch.funding_txid, ch.funding_vout,
             ch.p2sh_address);
    return dup_str(out);
}

/* Alice signs a payment paying Bob (to_bob) cumulative. */
char * KEEP pcw_payment_create(const char *alice_pub, const char *bob_pub,
                               unsigned locktime, int chain,
                               const char *funding_tx, const char *alice_wif,
                               const char *alice_addr, const char *bob_addr,
                               const char *txid, int vout, double cap,
                               double to_bob, double fee)
{
    pc_channel ch;
    pc_result r = pc_channel_init(&ch, alice_pub, bob_pub, locktime, (pc_chain)chain);
    if (r != PC_OK) return errf("channel_init", r);
    r = pc_channel_set_funding(&ch, txid, vout, (uint64_t)cap);
    if (r != PC_OK) return errf("set_funding", r);

    char *psbt = NULL;
    r = pc_payment_create(&ch, funding_tx, alice_wif, alice_addr, bob_addr,
                          (uint64_t)to_bob, (uint64_t)fee, &psbt);
    if (r != PC_OK) return errf("payment_create", r);

    char *out = (char *)malloc(strlen(psbt) + 64);
    if (!out) { free(psbt); return dup_str("{\"err\":\"oom\"}"); }
    sprintf(out, "{\"psbt\":\"%s\"}", psbt);
    free(psbt);
    return out;
}

/* Bob's ratchet check, then his signature and the assembled transaction.
 * (paid) is what he has already accepted on this channel, so the page can
 * replay an old state at him and watch it refused. */
char * KEEP pcw_payment_accept(const char *alice_pub, const char *bob_pub,
                               unsigned locktime, int chain,
                               const char *psbt, const char *bob_wif,
                               const char *txid, int vout, double cap,
                               double paid, double claimed)
{
    pc_channel ch;
    pc_result r = pc_channel_init(&ch, alice_pub, bob_pub, locktime, (pc_chain)chain);
    if (r != PC_OK) return errf("channel_init", r);
    r = pc_channel_set_funding(&ch, txid, vout, (uint64_t)cap);
    if (r != PC_OK) return errf("set_funding", r);
    ch.paid_to_bob_koinu = (uint64_t)paid;

    r = pc_payment_accept(&ch, psbt, (uint64_t)claimed);
    if (r != PC_OK) return errf("payment_accept", r);

    char *raw = NULL;
    r = pc_payment_countersign(&ch, psbt, bob_wif, &raw);
    if (r != PC_OK) return errf("countersign", r);

    /* the check that makes the countersignature safe to rely on */
    pc_result v = pc_tx_verify_payment(&ch, raw, (uint64_t)claimed);
    if (v != PC_OK) { free(raw); return errf("verify_payment", v); }

    char *out = (char *)malloc(strlen(raw) + 128);
    if (!out) { free(raw); return dup_str("{\"err\":\"oom\"}"); }
    sprintf(out, "{\"raw\":\"%s\",\"paid\":%llu}", raw,
            (unsigned long long)ch.paid_to_bob_koinu);
    free(raw);
    return out;
}

/* Verify an arbitrary transaction against the channel, so the page can hand
 * Bob a tampered one and show which check catches it. */
char * KEEP pcw_verify(const char *alice_pub, const char *bob_pub,
                       unsigned locktime, int chain,
                       const char *raw, const char *txid, int vout,
                       double cap, double claimed)
{
    pc_channel ch;
    pc_result r = pc_channel_init(&ch, alice_pub, bob_pub, locktime, (pc_chain)chain);
    if (r != PC_OK) return errf("channel_init", r);
    r = pc_channel_set_funding(&ch, txid, vout, (uint64_t)cap);
    if (r != PC_OK) return errf("set_funding", r);

    r = pc_tx_verify_payment(&ch, raw, (uint64_t)claimed);
    if (r != PC_OK) return errf("verify_payment", r);
    return dup_str("{\"ok\":1}");
}

/* Alice's refund, spendable only at locktime. */
char * KEEP pcw_refund(const char *alice_pub, const char *bob_pub,
                       unsigned locktime, int chain,
                       const char *alice_wif, const char *alice_addr,
                       const char *txid, int vout, double cap, double fee)
{
    pc_channel ch;
    pc_result r = pc_channel_init(&ch, alice_pub, bob_pub, locktime, (pc_chain)chain);
    if (r != PC_OK) return errf("channel_init", r);
    r = pc_channel_set_funding(&ch, txid, vout, (uint64_t)cap);
    if (r != PC_OK) return errf("set_funding", r);

    char *raw = NULL;
    r = pc_refund_create(&ch, alice_wif, alice_addr, (uint64_t)fee, &raw);
    if (r != PC_OK) return errf("refund_create", r);

    char *out = (char *)malloc(strlen(raw) + 64);
    if (!out) { free(raw); return dup_str("{\"err\":\"oom\"}"); }
    sprintf(out, "{\"raw\":\"%s\"}", raw);
    free(raw);
    return out;
}

/* The wire line alice and bob actually exchange, so the page shows the
 * protocol rather than a drawing of it. */
char * KEEP pcw_envelope(int type, const char *ref, int vout, double to_bob,
                         const char *addr, const char *psbt)
{
    pc_envelope env;
    memset(&env, 0, sizeof(env));
    env.type = (pc_msg_type)type;
    env.vout = vout;
    env.to_bob_koinu = (uint64_t)to_bob;
    snprintf(env.ref, sizeof(env.ref), "%s", ref ? ref : "");
    snprintf(env.addr, sizeof(env.addr), "%s", addr ? addr : "");
    snprintf(env.psbt_hex, sizeof(env.psbt_hex), "%s", psbt ? psbt : "");

    char *line = (char *)malloc(PC_MAX_PSBT_HEX + 1024);
    if (!line) return dup_str("{\"err\":\"oom\"}");
    if (pc_envelope_encode(&env, line, PC_MAX_PSBT_HEX + 1024) != PC_OK) {
        free(line);
        return dup_str("{\"err\":\"encode\"}");
    }
    return line;
}
