import { posix } from "node:path";

export const OWNERSHIP_MOVED = "ownership moved to omo-coworkers OpenChamber extension; legacy deployment/update refused (nothing written). Use the extension's explicit preview/apply/rollback; historical sources are reference only";

// Policy is code-owned, not candidate/authority-owned: old or edited records
// cannot remove the fence. Normalize aliases before inspecting the write set.
export function assertLegacyOwnership(paths) {
  for (const path of paths) {
    const normalized = typeof path === "string" ? posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\/+/, "") : "";
    if (/^oh-my-opencode-slim(?:\.jsonc?$|\/|$)/.test(normalized)) {
      const error = new Error(`${path}: ${OWNERSHIP_MOVED}`);
      error.code = 2;
      throw error;
    }
  }
}
