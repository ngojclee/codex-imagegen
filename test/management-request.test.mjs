import assert from "node:assert/strict";
import test from "node:test";

import { buildManagementRequestInit } from "../public/assets/management-request.js";

test("management request helper preserves JSON headers while adding CSRF", () => {
  const init = buildManagementRequestInit({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_url: "http://localhost:1455/auth/callback?code=c&state=s" }),
  });

  assert.equal(init.credentials, "same-origin");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.accept, "application/json");
  assert.equal(init.headers["content-type"], "application/json");
  assert.equal(init.headers["x-codex-imagegen-csrf"], "1");
  assert.equal(JSON.parse(init.body).callback_url.includes("/auth/callback"), true);
});

test("management request helper does not add CSRF to safe GET requests", () => {
  const init = buildManagementRequestInit();

  assert.equal(init.credentials, "same-origin");
  assert.equal(init.headers.accept, "application/json");
  assert.equal(Object.hasOwn(init.headers, "x-codex-imagegen-csrf"), false);
});
