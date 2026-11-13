import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";

describe("configuration safety", () => {
  it("defaults to loopback with mutations disabled", () => {
    const config = loadConfig({});
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 8787);
    assert.equal(config.allowMutations, false);
    assert.equal(config.authMode, "server");
  });

  it("rejects public binding without endpoint authentication", () => {
    assert.throws(() => loadConfig({ HOST: "0.0.0.0" }), /MCP_BEARER_TOKEN is required/);
  });

  it("allows public binding when request bearer tokens are MaiMemo tokens", () => {
    const config = loadConfig({ HOST: "0.0.0.0", AUTH_MODE: "maimemo-token" });
    assert.equal(config.authMode, "maimemo-token");
  });

  it("places review data in the writable state directory or an explicit configured path", () => {
    assert.equal(loadConfig({ STATE_DIRECTORY: "/var/lib/momo-mcp" }).localReviewDbPath, "/var/lib/momo-mcp/review.sqlite");
    assert.equal(loadConfig({ XDG_STATE_HOME: "/tmp/review-state" }).localReviewDbPath, "/tmp/review-state/momo-mcp/review.sqlite");
    assert.equal(loadConfig({ LOCAL_REVIEW_DB_PATH: "/tmp/custom.sqlite" }).localReviewDbPath, "/tmp/custom.sqlite");
  });
});
