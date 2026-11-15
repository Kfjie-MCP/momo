import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import type { AppConfig } from "../src/config.js";
import { createApp } from "../src/server.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 0,
  mcpPath: "/momo",
  allowedHosts: undefined,
  maimemoApiToken: undefined,
  mcpBearerToken: undefined,
  authMode: "maimemo-token",
  allowMutations: false,
  cliTimeoutMs: 5_000
};

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "request-auth-test", version: "0.1.0" }
  }
};

describe("request-scoped MaiMemo authentication", () => {
  let baseUrl = "";
  let httpServer: ReturnType<ReturnType<typeof createApp>["listen"]>;

  before(async () => {
    const app = createApp(config);
    httpServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => httpServer.once("listening", resolve));
    const address = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it("requires a bearer token", async () => {
    const response = await fetch(`${baseUrl}/momo`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify(initializeBody)
    });
    assert.equal(response.status, 401);
  });

  it("redirects browser visits to the center without weakening MCP authentication", async () => {
    for (const path of ["/momo", "/momo/"]) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { accept: "text/html" }, redirect: "manual" });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "/center/");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("vary"), "Accept");
      await response.body?.cancel();
    }
    const unauthorized = await fetch(`${baseUrl}/momo`, { headers: { accept: "text/event-stream" } });
    assert.equal(unauthorized.status, 401);
    const sse = await fetch(`${baseUrl}/momo`, { headers: { accept: "text/event-stream", authorization: "Bearer test-only-token" } });
    assert.equal(sse.status, 405);
    const deletion = await fetch(`${baseUrl}/momo`, { method: "DELETE" });
    assert.equal(deletion.status, 401);
  });

  it("accepts a request-scoped bearer token without storing it", async () => {
    const response = await fetch(`${baseUrl}/momo`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-only-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify(initializeBody)
    });
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /test-only-token/);
  });
});
