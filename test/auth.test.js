const { test, describe } = require('node:test');
const assert = require('node:assert');

process.env.ADMIN_PIN = 'test-pin-9174';
const auth = require('../lib/auth');

describe('staff PIN verification', () => {
  test('accepts the configured PIN', () => {
    assert.equal(auth.verifyPin('test-pin-9174'), true);
  });

  test('rejects a wrong PIN', () => {
    assert.equal(auth.verifyPin('nope'), false);
  });

  test('rejects empty, null and undefined without throwing', () => {
    for (const bad of ['', null, undefined, 0, false]) {
      assert.equal(auth.verifyPin(bad), false, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('fails closed when ADMIN_PIN is unset', () => {
    const saved = process.env.ADMIN_PIN;
    delete process.env.ADMIN_PIN;
    // An unconfigured deployment must reject everything, not accept everything.
    assert.equal(auth.verifyPin('anything'), false);
    assert.equal(auth.verifyPin(''), false);
    assert.equal(auth.verifyPin(undefined), false);
    process.env.ADMIN_PIN = saved;
  });

  test('does not accept a PIN that merely shares a prefix', () => {
    assert.equal(auth.verifyPin('test-pin-917'), false);
    assert.equal(auth.verifyPin('test-pin-91744'), false);
  });
});

describe('session lifecycle', () => {
  test('a created session validates, and a destroyed one does not', () => {
    const token = auth.createSession();
    assert.ok(token && token.length >= 32);
    assert.equal(auth.isValidSession(token), true);
    auth.destroySession(token);
    assert.equal(auth.isValidSession(token), false);
  });

  test('unknown, empty and null tokens are rejected', () => {
    for (const bad of ['deadbeef', '', null, undefined]) {
      assert.equal(auth.isValidSession(bad), false);
    }
  });

  test('two sessions get distinct tokens', () => {
    const a = auth.createSession();
    const b = auth.createSession();
    assert.notEqual(a, b);
  });
});

describe('requireStaff middleware', () => {
  function fakeRes() {
    return {
      statusCode: null, body: null, headers: {},
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
      setHeader(k, v) { this.headers[k] = v; },
    };
  }

  test('rejects a request with no cookie', () => {
    const res = fakeRes();
    let nextCalled = false;
    auth.requireStaff({ headers: {} }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false, 'must not reach the handler');
    assert.equal(res.statusCode, 401);
  });

  test('rejects a forged session cookie', () => {
    const res = fakeRes();
    let nextCalled = false;
    auth.requireStaff({ headers: { cookie: `${auth.COOKIE_NAME}=forged` } }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  test('allows a request carrying a real session cookie', () => {
    const token = auth.createSession();
    const res = fakeRes();
    let nextCalled = false;
    auth.requireStaff({ headers: { cookie: `other=x; ${auth.COOKIE_NAME}=${token}` } }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, 'valid session must reach the handler');
    assert.equal(res.statusCode, null);
  });
});

describe('assertAdminPinConfigured', () => {
  test('rejects placeholder and missing PINs', () => {
    const saved = process.env.ADMIN_PIN;
    for (const weak of ['', 'change-me', 'admin', '1234', '0000']) {
      process.env.ADMIN_PIN = weak;
      assert.equal(auth.assertAdminPinConfigured(), false, `${weak} must be refused`);
    }
    delete process.env.ADMIN_PIN;
    assert.equal(auth.assertAdminPinConfigured(), false);
    process.env.ADMIN_PIN = saved;
  });

  test('accepts a real PIN', () => {
    process.env.ADMIN_PIN = 'a-genuinely-set-pin';
    assert.equal(auth.assertAdminPinConfigured(), true);
  });
});
