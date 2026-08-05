import test from "node:test";
import assert from "node:assert/strict";

import { isExtensionContextInvalidated } from "@/lib/extension-context";

test("recognizes Chrome's invalidated extension context errors", () => {
  assert.equal(
    isExtensionContextInvalidated(new Error("Extension context invalidated.")),
    true,
  );
  assert.equal(
    isExtensionContextInvalidated({ message: "Extension context invalidated." }),
    true,
  );
  assert.equal(isExtensionContextInvalidated("Extension context invalidated."), true);
});

test("does not hide unrelated messaging and sync failures", () => {
  assert.equal(
    isExtensionContextInvalidated(new Error("Could not establish connection.")),
    false,
  );
  assert.equal(isExtensionContextInvalidated(new Error("Portal request failed.")), false);
});
