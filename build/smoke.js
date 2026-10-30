/* Drives the wasm the way the page will, so a break shows up here first. */
const PC = require('../demo/pc.js');

const DOGE = 1e8;

PC().then(m => {
  const call = (fn, types, args) =>
    JSON.parse(m.ccall(fn, 'string', types, args));
  const S = 'string', N = 'number';

  m.ccall('pcw_start', null, [], []);

  const REGTEST = 2;
  const alice = call('pcw_keypair', [N], [REGTEST]);
  const bob   = call('pcw_keypair', [N], [REGTEST]);
  console.log('alice', alice.addr, '\nbob  ', bob.addr);

  const locktime = 800;
  const ch = call('pcw_channel', [S, S, N, N], [alice.pub, bob.pub, locktime, REGTEST]);
  console.log('channel', ch.addr);
  console.log('redeem ', ch.redeem.slice(0, 40) + '...');

  const fund = call('pcw_funding', [S, S, S], [ch.addr, alice.addr, '100.0']);
  console.log('funding', fund.txid, 'vout', fund.vout);

  const open = call('pcw_open_create', [S, S, N, N, S],
                    [alice.pub, bob.pub, locktime, REGTEST, fund.tx]);
  if (open.err) throw new Error('open_create: ' + open.why);

  const acc = call('pcw_open_accept', [S, S, N, N, S, S, N, N],
                   [alice.pub, bob.pub, locktime, REGTEST, open.psbt, fund.tx, 300, 100]);
  if (acc.err) throw new Error('open_accept: ' + acc.why);
  console.log('accepted capacity', acc.capacity / DOGE, 'DOGE');

  // three cumulative payments, each verified by bob's own code
  let paid = 0;
  for (const amount of [5, 12.5, 30]) {
    const to = amount * DOGE;
    const pay = call('pcw_payment_create', [S, S, N, N, S, S, S, S, S, N, N, N, N],
      [alice.pub, bob.pub, locktime, REGTEST, fund.tx, alice.wif, alice.addr,
       bob.addr, fund.txid, fund.vout, acc.capacity, to, 1 * DOGE]);
    if (pay.err) throw new Error('payment_create: ' + pay.why);

    const ok = call('pcw_payment_accept', [S, S, N, N, S, S, S, N, N, N, N],
      [alice.pub, bob.pub, locktime, REGTEST, pay.psbt, bob.wif,
       fund.txid, fund.vout, acc.capacity, paid, to]);
    if (ok.err) throw new Error('payment_accept: ' + ok.why);
    paid = ok.paid;
    console.log(`paid ${amount} DOGE cumulative, tx ${ok.raw.length / 2} bytes`);
  }

  // the ratchet: replaying an earlier state must be refused
  const stale = call('pcw_payment_create', [S, S, N, N, S, S, S, S, S, N, N, N, N],
    [alice.pub, bob.pub, locktime, REGTEST, fund.tx, alice.wif, alice.addr,
     bob.addr, fund.txid, fund.vout, acc.capacity, 5 * DOGE, 1 * DOGE]);
  const replay = call('pcw_payment_accept', [S, S, N, N, S, S, S, N, N, N, N],
    [alice.pub, bob.pub, locktime, REGTEST, stale.psbt, bob.wif,
     fund.txid, fund.vout, acc.capacity, paid, 5 * DOGE]);
  console.log('replay of payment 1 after payment 3:',
              replay.err ? 'REFUSED (' + replay.why + ')' : 'ACCEPTED -- BUG');

  // alice's refund, spendable only at locktime
  const ref = call('pcw_refund', [S, S, N, N, S, S, S, N, N, N],
    [alice.pub, bob.pub, locktime, REGTEST, alice.wif, alice.addr,
     fund.txid, fund.vout, acc.capacity, 1 * DOGE]);
  console.log('refund', ref.err ? 'FAILED ' + ref.why : ref.raw.length / 2 + ' bytes');

  // the wire line, as alice and bob actually exchange it
  const line = m.ccall('pcw_envelope', 'string', ['number','string','number','number','string','string'],
                       [1, fund.txid, 0, 0, '', '']);
  console.log('wire  ', line.slice(0, 90));

  m.ccall('pcw_stop', null, [], []);
  console.log('\nsmoke ok');
}).catch(e => { console.error('FAILED', e); process.exit(1); });
