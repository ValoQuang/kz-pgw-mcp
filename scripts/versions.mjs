// Files that carry the package version. Used by version-sync.mjs and check.mjs.
export const PKG_NAME = "@valoquang/kz-pgw-mcp";

const pinIndex = (args) => args.findIndex((a) => a.startsWith(`${PKG_NAME}@`));

export const VERSION_FILES = [
  {
    file: "manifest.json",
    get: (j) => [j.version],
    set: (j, v) => void (j.version = v),
  },
  {
    file: ".claude-plugin/plugin.json",
    // version + the npx pin, so plugin skills and server always match.
    get: (j) => {
      const args = j.mcpServers["kz-pgw"].args;
      const i = pinIndex(args);
      return [j.version, i < 0 ? "(no pin)" : args[i].slice(PKG_NAME.length + 1)];
    },
    set: (j, v) => {
      j.version = v;
      const args = j.mcpServers["kz-pgw"].args;
      const i = pinIndex(args);
      if (i < 0) args.push(`${PKG_NAME}@${v}`);
      else args[i] = `${PKG_NAME}@${v}`;
    },
  },
  {
    file: ".claude-plugin/marketplace.json",
    get: (j) => j.plugins.map((p) => p.version),
    set: (j, v) => j.plugins.forEach((p) => (p.version = v)),
  },
];
