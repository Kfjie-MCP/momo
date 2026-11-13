import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCliArgs, isDeletion, isMutation } from "../src/cli.js";

describe("CLI argument construction", () => {
  it("builds fixed JSON output and repeated array flags", () => {
    assert.deepEqual(
      buildCliArgs({
        resource: "study",
        action: "records",
        options: { fields: "id,spelling", vocId: ["v1", "v2"], header: undefined }
      }),
      [
        "study",
        "records",
        "--fields",
        "id,spelling",
        "--voc-id",
        "v1",
        "--voc-id",
        "v2",
        "-O",
        "json",
        "--no-color"
      ]
    );
  });

  it("rejects caller-controlled credentials and output flags", () => {
    assert.throws(
      () => buildCliArgs({ resource: "voc", action: "get", options: { token: "secret" } }),
      /managed by the server/
    );
    assert.throws(
      () => buildCliArgs({ resource: "voc", action: "get", options: { output: "column" } }),
      /managed by the server/
    );
  });

  it("adds force only to an explicitly confirmed deletion", () => {
    assert.equal(isDeletion("note", "delete"), true);
    assert.deepEqual(
      buildCliArgs({ resource: "note", action: "delete", positionals: ["n1"], confirmed: true }),
      ["note", "delete", "n1", "-f", "-O", "json", "--no-color"]
    );
  });
});

describe("mutation classification", () => {
  it("separates reads from writes", () => {
    assert.equal(isMutation("study", "records"), false);
    assert.equal(isMutation("study", "add"), true);
    assert.equal(isMutation("notepad", "delete"), true);
  });
});
