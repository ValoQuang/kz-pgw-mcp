import { readFileSync } from "node:fs";

import { PKG_JSON } from "./paths.js";

function read(): string {
  try {
    return (JSON.parse(readFileSync(PKG_JSON, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = read();
