import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { AppConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { compatibilityToolNames, operations } from "../src/official.js";
import { enhancedToolNames } from "../src/enhanced.js";
import { reviewToolNames } from "../src/review.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 0,
  mcpPath: "/mcp",
  allowedHosts: undefined,
  maimemoApiToken: undefined,
  mcpBearerToken: undefined,
  authMode: "server",
  allowMutations: false,
  cliTimeoutMs: 5_000
};

describe("MCP HTTP server", () => {
  let baseUrl = "";
  let httpServer: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let client: Client;

  before(async () => {
    const app = createApp(config);
    httpServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => httpServer.once("listening", resolve));
    const address = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    client = new Client({ name: "momo-mcp-test", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
  });

  after(async () => {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it("reports health without exposing secrets", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: "momo-mcp",
      tokenConfigured: false,
      authenticationMode: "server",
      mutationsEnabled: false
    });
  });

  it("exposes the intended tool surface", async () => {
    const result = await client.listTools();
    for (const tool of result.tools) assert.ok(tool.outputSchema, `${tool.name} outputSchema missing`);
    assert.deepEqual(
      result.tools.map((tool) => tool.name).sort(),
      ["maimemo_help", "maimemo_read", "maimemo_status", "maimemo_write", "maimemo_documentation", ...operations.map(op => op.name), ...compatibilityToolNames, ...enhancedToolNames, ...reviewToolNames].sort()
    );
  });

  it("returns redacted configuration status", async () => {
    const result = await client.callTool({ name: "maimemo_status", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.ok(Array.isArray(result.content));
    const first = result.content[0] as { type?: string; text?: string } | undefined;
    assert.equal(first?.type, "text");
    if (first?.type !== "text" || typeof first.text !== "string") {
      throw new Error("Expected text response");
    }
    const parsed = JSON.parse(first.text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.maimemoTokenConfigured, false);
    assert.deepEqual(result.structuredContent, parsed);
  });

  it("serves all official documentation resources and workflow prompts", async () => {
    const resources = await client.listResources();
    assert.equal(resources.resources.length, 9);
    for (const resource of resources.resources) {
      const result = await client.readResource({ uri: resource.uri });
      assert.ok((result.contents[0] as { text: string }).text.length > 100);
    }
    const prompts = await client.listPrompts();
    assert.equal(prompts.prompts.length, 2);
    for (const prompt of prompts.prompts) {
      const result = await client.getPrompt({ name: prompt.name, arguments: { task: "test" } });
      assert.equal(result.messages.length, 1);
    }
  });

  it("invokes the pinned memo-api CLI for help", async () => {
    const result = await client.callTool({
      name: "maimemo_help",
      arguments: { resource: "voc", action: "get" }
    });
    assert.equal(result.isError, undefined);
    assert.ok(Array.isArray(result.content));
    const first = result.content[0] as { type?: string; text?: string } | undefined;
    assert.equal(first?.type, "text");
    if (first?.type !== "text" || typeof first.text !== "string") {
      throw new Error("Expected text response");
    }
    assert.match(first.text, /spelling|单词/i);
  });

  it("rejects API reads until the server token is configured", async () => {
    const result = await client.callTool({
      name: "maimemo_read",
      arguments: { resource: "voc", action: "get", options: { spelling: "apple" } }
    });
    assert.equal(result.isError, true);
    const expected = {
      ok: false,
      data: null,
      error: "MAIMEMO_API_TOKEN is not configured on the server."
    };
    const content = result.structuredContent as any;
    assert.deepEqual({ ok: content.ok, data: content.data, error: content.error }, expected);
    assert.equal(content.error_details.code, "AUTH_REQUIRED");
  });
});
