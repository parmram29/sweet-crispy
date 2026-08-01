const { test, describe } = require('node:test');
const assert = require('node:assert');
const { makeRef, rateLimit, parsePaging } = require('../lib/security');

describe('makeRef', () => {
  test('is prefixed and uppercase-hex', () => {
    assert.match(makeRef('ORD'), /^ORD-[0-9A-F]{8}$/);
  });

  test('does not repeat across many calls', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) seen.add(makeRef('ORD'));
    assert.equal(seen.size, 2000, 'references must not collide in a small sample');
  });
});

describe('parsePaging', () => {
  test('applies defaults when nothing is supplied', () => {
    assert.deepEqual(parsePaging({}), { limit: 50, offset: 0 });
  });

  test('clamps an oversized limit to the ceiling', () => {
    // Without this a caller could ask for the entire table in one request.
    assert.equal(parsePaging({ limit: '100000' }).limit, 200);
  });

  test('ignores junk, negative and zero values', () => {
    for (const bad of ['abc', '-5', '0', '', null, undefined, {}]) {
      const { limit, offset } = parsePaging({ limit: bad, offset: bad });
      assert.equal(limit, 50, `limit for ${JSON.stringify(bad)}`);
      assert.equal(offset, 0, `offset for ${JSON.stringify(bad)}`);
    }
  });

  test('honours a valid window', () => {
    assert.deepEqual(parsePaging({ limit: '25', offset: '75' }), { limit: 25, offset: 75 });
  });
});

describe('rateLimit', () => {
  function fakeRes() {
    return {
      statusCode: null, body: null, headers: {},
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
      setHeader(k, v) { this.headers[k] = v; },
    };
  }
  const reqFrom = (ip) => ({ ip, socket: { remoteAddress: ip } });

  test('allows up to the limit then blocks with 429 + Retry-After', () => {
    const mw = rateLimit('t1', 3, 60_000);
    const req = reqFrom('1.1.1.1');

    for (let i = 0; i < 3; i++) {
      const res = fakeRes();
      let passed = false;
      mw(req, res, () => { passed = true; });
      assert.equal(passed, true, `request ${i + 1} should pass`);
    }

    const res = fakeRes();
    let passed = false;
    mw(req, res, () => { passed = true; });
    assert.equal(passed, false, 'the 4th request must be blocked');
    assert.equal(res.statusCode, 429);
    assert.ok(res.headers['Retry-After'], 'must tell the client when to retry');
  });

  test('counts each client address separately', () => {
    const mw = rateLimit('t2', 1, 60_000);
    let aPassed = false; let bPassed = false;
    mw(reqFrom('2.2.2.2'), fakeRes(), () => { aPassed = true; });
    mw(reqFrom('3.3.3.3'), fakeRes(), () => { bPassed = true; });
    // One busy customer must not lock out everyone else.
    assert.equal(aPassed, true);
    assert.equal(bPassed, true);
  });

  test('the window resets, so a blocked client recovers', async () => {
    const mw = rateLimit('t3', 1, 20);
    const req = reqFrom('4.4.4.4');
    mw(req, fakeRes(), () => {});

    let blocked = fakeRes(); let passed = false;
    mw(req, blocked, () => { passed = true; });
    assert.equal(passed, false, 'second request inside the window is blocked');

    await new Promise(r => setTimeout(r, 40));
    let recovered = false;
    mw(req, fakeRes(), () => { recovered = true; });
    assert.equal(recovered, true, 'client recovers after the window elapses');
  });

  test('falls back to a stable key when the address is unknown', () => {
    const mw = rateLimit('t4', 1, 60_000);
    const anon = { socket: {} };
    let first = false; let second = false;
    mw(anon, fakeRes(), () => { first = true; });
    mw(anon, fakeRes(), () => { second = true; });
    assert.equal(first, true);
    assert.equal(second, false, 'unknown-address clients still share a bucket rather than bypassing the limit');
  });
});
