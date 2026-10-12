/** Tiny prompt helpers on node:readline. No deps. Works on a TTY and with piped answers. */

import { createInterface, type Interface } from "node:readline";
import { stdin, stdout } from "node:process";

const tty = Boolean(stdin.isTTY);
let rl: Interface | null = null;
let muted = false;

// Non-TTY: buffer lines so answers piped in one chunk are not lost.
const queue: string[] = [];
const waiters: ((s: string) => void)[] = [];
let closed = false;

function iface(): Interface {
  if (rl) return rl;
  rl = createInterface({ input: stdin, output: tty ? stdout : undefined, terminal: tty });
  if (!tty) {
    rl.on("line", (l) => (waiters.length ? waiters.shift()!(l) : queue.push(l)));
    rl.on("close", () => {
      closed = true;
      while (waiters.length) waiters.shift()!("");
    });
    return rl;
  }
  // TTY: mask input while a secret is being typed.
  const r = rl as unknown as { _writeToOutput: (s: string) => void };
  const orig = r._writeToOutput.bind(rl);
  r._writeToOutput = (s: string) => {
    if (!muted || /[\r\n]/.test(s) || s.endsWith(": ")) orig(s);
  };
  return rl;
}

function question(q: string): Promise<string> {
  const r = iface();
  if (tty) return new Promise((resolve) => r.question(q, resolve));
  stdout.write(q);
  if (queue.length) return Promise.resolve(queue.shift()!);
  if (closed) return Promise.resolve("");
  return new Promise((resolve) => waiters.push(resolve));
}

export function close(): void {
  rl?.close();
  rl = null;
}

export async function input(message: string, opts: { default?: string; required?: boolean } = {}): Promise<string> {
  for (;;) {
    const suffix = opts.default ? ` [${opts.default}]` : "";
    const v = (await question(`? ${message}${suffix}: `)).trim();
    if (!tty) stdout.write("\n");
    if (v) return v;
    if (opts.default !== undefined) return opts.default;
    if (!opts.required) return "";
    if (closed) throw new Error(`${message}: required, no input left`);
    stdout.write("  required\n");
  }
}

export async function password(message: string, opts: { keepIfEmpty?: boolean; required?: boolean } = {}): Promise<string> {
  for (;;) {
    muted = true;
    const hint = opts.keepIfEmpty ? " (empty = keep current)" : "";
    let v: string;
    try {
      v = await question(`? ${message}${hint}: `);
    } finally {
      muted = false;
      stdout.write("\n");
    }
    if (v || opts.keepIfEmpty || !opts.required) return v;
    if (closed) throw new Error(`${message}: required, no input left`);
    stdout.write("  required\n");
  }
}

export async function confirm(message: string, def = false): Promise<boolean> {
  const v = (await question(`? ${message} ${def ? "[Y/n]" : "[y/N]"}: `)).trim().toLowerCase();
  if (!tty) stdout.write("\n");
  if (!v) return def;
  return v === "y" || v === "yes";
}

export async function select<T extends string>(message: string, choices: { value: T; name: string }[], def?: T): Promise<T> {
  const defIdx = Math.max(0, choices.findIndex((c) => c.value === def));
  for (;;) {
    stdout.write(`? ${message}\n`);
    choices.forEach((c, i) => stdout.write(`  ${i + 1}) ${c.name}${i === defIdx ? "  (default)" : ""}\n`));
    const v = (await question(`  choose 1-${choices.length}: `)).trim();
    if (!tty) stdout.write("\n");
    if (!v) return choices[defIdx].value;
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value;
  }
}
