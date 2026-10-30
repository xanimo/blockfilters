/* Drives the wasm. Every number and every refusal below came out of the C;
   this file decides what to call and in what order and computes nothing. */
(function () {
  const DOGE = 1e8;
  const REGTEST = 2;
  const FEE = DOGE;
  const S = 'string', N = 'number';

  const $ = id => document.getElementById(id);
  const log = $('log');
  let m = null, st = null;

  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const put = html => { log.innerHTML += html + '\n'; log.scrollTop = log.scrollHeight; };
  const wire = (dir, text) =>
    put('<span class="' + (dir === '>' ? 'a2b' : 'b2a') + '">' + (dir === '>' ? 'alice → bob' : 'bob → alice') + '</span>  ' + esc(text));
  const note = t => put('<span class="lbl">' + esc(t) + '</span>');
  const good = t => put('<span class="ok">' + esc(t) + '</span>');
  const bad = t => put('<span class="no">' + esc(t) + '</span>');
  const doge = k => {
    const s = (k / DOGE).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
    return s + ' DOGE';
  };
  const clip = (s, n) => s.length > n ? s.slice(0, n) + '…' : s;

  function call(fn, types, args) {
    const t0 = performance.now();
    const r = JSON.parse(m.ccall(fn, 'string', types, args));
    r._ms = performance.now() - t0;
    return r;
  }

  function paint() {
    const paid = st ? st.paid : 0;
    const cap = st ? st.cap : 0;
    const pct = cap ? (paid / cap) * 100 : 0;
    $('bar-bob').style.width = pct + '%';
    $('v-cap').textContent = cap ? doge(cap) : '—';
    $('v-bob').textContent = doge(paid);
    $('v-alice').textContent = doge(Math.max(0, cap - paid));
    $('v-onchain').textContent = st ? st.onchain : '0';
  }

  function enable(on) {
    ['pay', 'amount', 'atk-replay', 'atk-overclaim', 'atk-capacity', 'close']
      .forEach(id => { $(id).disabled = !on; });
    document.querySelectorAll('[data-amt]').forEach(b => { b.disabled = !on; });
  }

  /* ---- open ---------------------------------------------------------- */

  function open() {
    log.textContent = '';
    st = { paid: 0, onchain: 0 };

    st.alice = call('pcw_keypair', [N], [REGTEST]);
    st.bob = call('pcw_keypair', [N], [REGTEST]);
    st.locktime = 800;

    const ch = call('pcw_channel', [S, S, N, N],
      [st.alice.pub, st.bob.pub, st.locktime, REGTEST]);
    st.addr = ch.addr;
    st.redeem = ch.redeem;

    note('both keys generated here, in this tab');
    note('channel  ' + ch.addr);
    note('redeem   OP_IF ' + st.locktime + ' CLTV DROP <alice> CHECKSIG OP_ELSE 2 <alice> <bob> 2 CHECKMULTISIG OP_ENDIF');
    put('');

    st.fund = call('pcw_funding', [S, S, S], [ch.addr, st.alice.addr, '100.0']);
    const open = call('pcw_open_create', [S, S, N, N, S],
      [st.alice.pub, st.bob.pub, st.locktime, REGTEST, st.fund.tx]);
    if (open.err) return bad('open_create: ' + open.why);

    wire('>', 'open  ref=' + clip(st.fund.txid, 20) + ' vout=' + st.fund.vout +
              ' psbt=' + clip(open.psbt, 28));

    const acc = call('pcw_open_accept', [S, S, N, N, S, S, N, N],
      [st.alice.pub, st.bob.pub, st.locktime, REGTEST, open.psbt, st.fund.tx, 300, 100]);
    if (acc.err) { bad('bob refused the open: ' + acc.why); return; }

    st.cap = acc.capacity;
    wire('<', 'accept  ' + doge(acc.capacity) + ' available');
    note('         bob worked the outpoint out of alice\'s funding transaction rather than');
    note('         being told it, and a real bob asks a chain here whether it is mined.');
    put('');
    enable(true);
    $('open').textContent = 'start over';
    paint();
  }

  /* ---- a payment ----------------------------------------------------- */

  function pay() {
    const inc = Math.round(parseFloat($('amount').value || '0') * DOGE);
    if (!(inc > 0)) return;
    const cum = st.paid + inc;

    const p = call('pcw_payment_create', [S, S, N, N, S, S, S, S, S, N, N, N, N],
      [st.alice.pub, st.bob.pub, st.locktime, REGTEST, st.fund.tx, st.alice.wif,
       st.alice.addr, st.bob.addr, st.fund.txid, st.fund.vout, st.cap, cum, FEE]);
    if (p.err) { wire('>', 'pay  ' + doge(cum) + ' cumulative'); bad('        alice could not build it: ' + p.why); return; }

    wire('>', 'pay  ' + doge(cum) + ' cumulative, psbt=' + clip(p.psbt, 28));

    const r = call('pcw_payment_accept', [S, S, N, N, S, S, S, N, N, N, N],
      [st.alice.pub, st.bob.pub, st.locktime, REGTEST, p.psbt, st.bob.wif,
       st.fund.txid, st.fund.vout, st.cap, st.paid, cum]);
    if (r.err) { bad('        refused: ' + r.why); return; }

    st.paid = r.paid;
    st.lastRaw = r.raw;
    if (!st.firstPsbt) { st.firstPsbt = p.psbt; st.firstAmount = cum; st.firstRaw = r.raw; }
    wire('<', 'ack  countersigned and verified, ' + r.raw.length / 2 + '-byte transaction');
    const ms = p._ms + r._ms;
    note('         signed and checked in ' + (ms < 0.01 ? '<0.01' : ms.toFixed(2)) + ' ms, nothing broadcast');
    paint();
  }

  /* ---- what bob refuses ---------------------------------------------- */

  function replay() {
    if (!st.firstPsbt) return note('make two payments first, then this has something to replay');
    put('');
    wire('>', 'pay  ' + doge(st.firstAmount) + ' cumulative   (the first payment, sent again)');
    const r = call('pcw_payment_accept', [S, S, N, N, S, S, S, N, N, N, N],
      [st.alice.pub, st.bob.pub, st.locktime, REGTEST, st.firstPsbt, st.bob.wif,
       st.fund.txid, st.fund.vout, st.cap, st.paid, st.firstAmount]);
    if (r.err) {
      bad('        refused by pc_payment_accept: ' + r.why);
      note('         ' + doge(st.firstAmount) + ' <= ' + doge(st.paid) + ' already paid, so the ratchet holds');
    } else bad('        ACCEPTED, which would be a bug');
  }

  function overclaim() {
    if (!st.firstRaw) return note('make a payment first');
    put('');
    wire('>', 'pay  this transaction pays ' + doge(st.firstAmount) + ', i am telling you it pays ' + doge(st.paid));
    const r = call('pcw_verify', [S, S, N, N, S, S, N, N, N],
      [st.alice.pub, st.bob.pub, st.locktime, REGTEST, st.firstRaw,
       st.fund.txid, st.fund.vout, st.cap, st.paid]);
    if (r.err) {
      bad('        refused by pc_tx_verify_payment: ' + r.why);
      note('         the outputs are read out of the raw bytes, so the claim is checked against them');
    } else bad('        ACCEPTED, which would be a bug');
  }

  function overCapacity() {
    const cum = st.cap + 50 * DOGE;
    put('');
    wire('>', 'pay  ' + doge(cum) + ' cumulative, against a ' + doge(st.cap) + ' channel');
    const p = call('pcw_payment_create', [S, S, N, N, S, S, S, S, S, N, N, N, N],
      [st.alice.pub, st.bob.pub, st.locktime, REGTEST, st.fund.tx, st.alice.wif,
       st.alice.addr, st.bob.addr, st.fund.txid, st.fund.vout, st.cap, cum, FEE]);
    if (p.err) { bad('        alice cannot even build it: ' + p.why); return; }
    const r = call('pcw_payment_accept', [S, S, N, N, S, S, S, N, N, N, N],
      [st.alice.pub, st.bob.pub, st.locktime, REGTEST, p.psbt, st.bob.wif,
       st.fund.txid, st.fund.vout, st.cap, st.paid, cum]);
    if (r.err) bad('        refused: ' + r.why);
    else bad('        ACCEPTED, which would be a bug');
  }

  function close() {
    put('');
    if (!st.lastRaw) {
      note('nothing to settle yet, the channel never moved');
      return;
    }
    wire('<', 'close  broadcasting the last transaction bob holds');
    note('         ' + st.lastRaw.length / 2 + ' bytes, pays bob ' + doge(st.paid) +
         ' and returns ' + doge(st.cap - st.paid - FEE) + ' to alice');
    st.onchain = 1;
    good('        one transaction on the chain for the whole session');
    const ref = call('pcw_refund', [S, S, N, N, S, S, S, N, N, N],
      [st.alice.pub, st.bob.pub, st.locktime, REGTEST, st.alice.wif, st.alice.addr,
       st.fund.txid, st.fund.vout, st.cap, FEE]);
    if (!ref.err)
      note('         alice also holds a ' + ref.raw.length / 2 + '-byte refund, spendable at height ' +
           st.locktime + ' if bob vanishes');
    enable(false);
    paint();
  }

  /* ---- wiring -------------------------------------------------------- */

  PC().then(mod => {
    m = mod;
    m.ccall('pcw_start', null, [], []);
    log.textContent = '';
    note('payment-channel compiled to wasm, linked against libsecp256k1.');
    note('open a channel to begin.');
    $('open').disabled = false;
  }).catch(e => { log.textContent = 'the wasm module did not load: ' + e; });

  $('open').onclick = open;
  $('pay').onclick = pay;
  $('atk-replay').onclick = replay;
  $('atk-overclaim').onclick = overclaim;
  $('atk-capacity').onclick = overCapacity;
  $('close').onclick = close;
  $('amount').addEventListener('keydown', e => { if (e.key === 'Enter') pay(); });
  document.querySelectorAll('[data-amt]').forEach(b => {
    b.onclick = () => { $('amount').value = b.dataset.amt; pay(); };
  });
})();
