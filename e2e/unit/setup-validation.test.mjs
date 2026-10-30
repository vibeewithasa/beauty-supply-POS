import test from "node:test";
import assert from "node:assert/strict";
import { describeConnectionError, parseConnection, parseFirstAdmin } from "../../src/backend/setup-validation.ts";

const code = (fn) => { try { fn(); return "OK"; } catch (e) { return e.code ?? "THROWN:" + e.message; } };
const good = () => ({ host: "localhost", port: "5432", database: "beauty_pos", user: "pos_runtime", password: "a-test-value-1" });

test("a valid connection parses (port as a string or number, empty password means none)", () => {
  assert.deepEqual(parseConnection(good(), false), { parts: { host: "localhost", port: 5432, database: "beauty_pos", user: "pos_runtime" }, password: "a-test-value-1" });
  assert.equal(parseConnection({ ...good(), port: 6543 }, false).parts.port, 6543);
  assert.equal(parseConnection({ ...good(), port: "" }, false).parts.port, 5432, "default port");
  assert.equal(parseConnection({ ...good(), password: "" }, false).password, null);
  assert.equal(parseConnection({ ...good(), password: undefined }, false).password, null);
  assert.equal(parseConnection({ ...good(), host: "[::1]" }, false).parts.host, "::1");
  assert.equal(parseConnection({ ...good(), host: " 127.0.0.1 " }, false).parts.host, "127.0.0.1");
});

test("only the five known fields are accepted", () => {
  for (const extra of [{ ssl: true }, { options: "-c x=1" }, { connectionString: "postgresql://x" }, { application_name: "x" }]) {
    assert.equal(code(() => parseConnection({ ...good(), ...extra }, false)), "CAMPO_NO_PERMITIDO", JSON.stringify(extra));
  }
  for (const notObject of [null, undefined, "x", 5, [], true]) assert.equal(code(() => parseConnection(notObject, false)), "CONEXION_INVALIDA");
});

test("bad ports, names and users are rejected with a stable code and without echoing what was typed", () => {
  for (const [patch, expected] of [
    [{ port: "0" }, "PUERTO_INVALIDO"], [{ port: "70000" }, "PUERTO_INVALIDO"], [{ port: "54x2" }, "PUERTO_INVALIDO"], [{ port: -1 }, "PUERTO_INVALIDO"], [{ port: 5432.5 }, "PUERTO_INVALIDO"],
    [{ host: "" }, "SERVIDOR_INVALIDO"], [{ database: "" }, "BASE_INVALIDA"], [{ user: "" }, "USUARIO_INVALIDO"],
    [{ database: "x'; drop table users;--" }, "CONEXION_INVALIDA"], [{ user: "a b" }, "CONEXION_INVALIDA"], [{ host: "a/b" }, "CONEXION_INVALIDA"], [{ database: "a\nb" }, "CONEXION_INVALIDA"],
    [{ password: 5 }, "CLAVE_INVALIDA"], [{ password: "x".repeat(201) }, "CLAVE_INVALIDA"], [{ password: "a\u0000b" }, "CLAVE_INVALIDA"],
  ]) {
    assert.equal(code(() => parseConnection({ ...good(), ...patch }, false)), expected, JSON.stringify(patch));
  }
  try { parseConnection({ ...good(), database: "x'; drop table users;--" }, false); } catch (e) { assert.equal(e.message.includes("drop table"), false, "the typed text is never echoed"); }
});

test("only local servers are accepted unless the operator opted in", () => {
  for (const host of ["db.example.com", "192.168.1.20", "10.0.0.5", "0.0.0.0", "localhost.evil.com"]) {
    assert.equal(code(() => parseConnection({ ...good(), host }, false)), "SERVIDOR_NO_LOCAL", host);
    assert.equal(code(() => parseConnection({ ...good(), host }, true)), "OK", host + " with POS_ALLOW_REMOTE_DB=1");
  }
});

test("the first administrator needs a name, a 6-8 digit PIN and a valid connection", () => {
  const ok = parseFirstAdmin({ connection: good(), name: "  Ana Leal ", pin: "246810" }, false);
  assert.equal(ok.name, "Ana Leal");
  assert.equal(ok.pin, "246810");
  assert.equal(ok.connection.parts.database, "beauty_pos");
  for (const pin of ["1234", "907654321", "76543a", "", 246810, null, "２４６８１０"]) assert.equal(code(() => parseFirstAdmin({ connection: good(), name: "A", pin }, false)), "PIN_INVALIDO", JSON.stringify(pin));
  for (const name of ["", "   ", "x".repeat(121), "a\nb", 5, null]) assert.equal(code(() => parseFirstAdmin({ connection: good(), name, pin: "246810" }, false)), "NOMBRE_INVALIDO", JSON.stringify(name));
  assert.equal(code(() => parseFirstAdmin({ connection: { ...good(), host: "evil.example" }, name: "A", pin: "246810" }, false)), "SERVIDOR_NO_LOCAL");
  assert.equal(code(() => parseFirstAdmin({ connection: good(), name: "A", pin: "246810", role: "admin" }, false)), "CAMPO_NO_PERMITIDO");
});

test("driver errors become safe, actionable messages that never carry driver text, credentials or the password", () => {
  const parts = { host: "localhost", port: 5432, database: "beauty_pos", user: "pos_runtime" };
  const cases = [
    [{ code: "ECONNREFUSED" }, "SIN_SERVIDOR", /localhost:5432/], [{ code: "ENOTFOUND" }, "SERVIDOR_DESCONOCIDO", /localhost/], [{ code: "28P01", message: 'password authentication failed for user "pos_runtime"' }, "ACCESO_DENEGADO", /incorrectos/],
    [{ code: "3D000" }, "SIN_BASE", /beauty_pos/], [{ message: "Connection terminated due to connection timeout" }, "TIEMPO_AGOTADO", /a tiempo/], [{ code: "57P03" }, "INICIANDO", /iniciando/], [{ code: "XX000", message: "secret detail postgresql:// plus credentials" }, "ERROR_CONEXION", /XX000/],
  ];
  for (const [err, expected, re] of cases) {
    const d = describeConnectionError(err, parts);
    assert.equal(d.code, expected);
    assert.match(d.message, re);
    assert.equal(/secret detail|postgresql:\/\/|password authentication/.test(d.message), false, "no driver text: " + d.message);
  }
  assert.equal(describeConnectionError(null, parts).code, "ERROR_CONEXION");
});
