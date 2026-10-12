/**
 * Optional SSH tunnel. Mirrors pgAdmin's "SSH Tunnel" tab.
 *
 * Set SSH_HOST (+ SSH_USER, SSH_PORT, SSH_PASSWORD or SSH_KEY_PATH) and every
 * Postgres connection is opened through the jump host. No local port is bound;
 * each pg client gets its own forwarded stream.
 */

import { existsSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import { Client as SshClient, type ConnectConfig } from "ssh2";

import { ssh } from "../core/config.js";
import { TIMEOUT_MS } from "../core/constants.js";

export interface TunnelConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: Buffer;
  passphrase?: string;
  agent?: string;
  /** Which auth sources were found, for error messages. */
  authSources: string[];
}

/** Default keys tried when SSH_KEY_PATH is unset, like the ssh CLI. */
const DEFAULT_KEYS = ["id_ed25519", "id_rsa", "id_ecdsa"].map((n) => join(homedir(), ".ssh", n));

/**
 * Auth order, like the ssh CLI: SSH_PASSWORD if set; SSH_KEY_PATH if set;
 * otherwise ssh-agent (SSH_AUTH_SOCK) plus the first default key found in
 * ~/.ssh. ssh2 tries every method given.
 */
export function tunnelFromEnv(): TunnelConfig | null {
  const host = ssh.host();
  if (!host) return null;

  const authSources: string[] = [];
  const password = ssh.password();
  if (password) authSources.push("password");

  const keyPath = ssh.keyPath() ?? DEFAULT_KEYS.find((p) => existsSync(p));
  const privateKey = keyPath ? readFileSync(keyPath) : undefined;
  if (keyPath) authSources.push(`key ${keyPath}`);

  const agent = process.env.SSH_AUTH_SOCK || undefined;
  if (agent) authSources.push("ssh-agent");

  if (!password && !privateKey && !agent) {
    throw new Error("SSH_HOST set but no auth: set SSH_PASSWORD or SSH_KEY_PATH, or run ssh-agent");
  }
  return {
    host,
    port: ssh.port(),
    username: ssh.user(),
    password,
    privateKey,
    passphrase: ssh.passphrase(),
    agent,
    authSources,
  };
}

export class Tunnel {
  private client: SshClient | null = null;
  private connecting: Promise<SshClient> | null = null;

  constructor(
    private readonly cfg: TunnelConfig,
    private readonly target: { host: string; port: number },
  ) {}

  get label(): string {
    return `${this.cfg.username}@${this.cfg.host}:${this.cfg.port}`;
  }

  private connect(): Promise<SshClient> {
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<SshClient>((resolve, reject) => {
      const c = new SshClient();
      const opts: ConnectConfig = {
        host: this.cfg.host,
        port: this.cfg.port,
        username: this.cfg.username,
        password: this.cfg.password,
        privateKey: this.cfg.privateKey,
        passphrase: this.cfg.passphrase,
        agent: this.cfg.agent,
        readyTimeout: TIMEOUT_MS.sshReady,
        keepaliveInterval: TIMEOUT_MS.sshKeepalive,
        keepaliveCountMax: 3,
      };
      c.on("ready", () => {
        this.client = c;
        this.connecting = null;
        console.error(`ssh tunnel up: ${this.label}`);
        resolve(c);
      });
      c.on("error", (err) => {
        this.connecting = null;
        if (this.client === c) this.client = null;
        reject(
          Object.assign(
            new Error(`ssh ${this.label}: ${err.message} (tried: ${this.cfg.authSources.join(", ")})`),
            { code: "ESSH" },
          ),
        );
      });
      c.on("close", () => {
        if (this.client === c) this.client = null;
        console.error("ssh tunnel closed");
      });
      c.connect(opts);
    });
    return this.connecting;
  }

  /** One forwarded TCP stream to the Postgres target. */
  async open(): Promise<Duplex> {
    const c = await this.connect();
    return new Promise<Duplex>((resolve, reject) => {
      c.forwardOut("127.0.0.1", 0, this.target.host, this.target.port, (err, stream: Duplex | PromiseLike<Duplex>) => {
        if (err) {
          reject(
            Object.assign(new Error(`ssh forward to ${this.target.host}:${this.target.port}: ${err.message}`), {
              code: "ESSH",
            }),
          );
          return;
        }
        resolve(stream);
      });
    });
  }

  /**
   * Local listener on 127.0.0.1:<random>. Every accepted socket is piped to a
   * fresh forwarded stream. pg then connects to this local port like a normal
   * host. Resolves with the port.
   */
  async listen(): Promise<{ host: string; port: number }> {
    if (this.server) return this.local!;
    // Fail fast if the jump host is unreachable or the password is wrong.
    await this.connect();
    const server = createServer((sock) => {
      sock.on("error", () => sock.destroy());
      this.open()
        .then((fwd) => {
          fwd.on("error", () => sock.destroy());
          sock.pipe(fwd).pipe(sock);
          sock.on("close", () => fwd.end());
          fwd.on("close", () => sock.destroy());
        })
        .catch((err: Error) => {
          console.error(err.message);
          sock.destroy();
        });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address() as AddressInfo;
    this.server = server;
    this.local = { host: "127.0.0.1", port: addr.port };
    return this.local;
  }

  private server: Server | null = null;
  private local: { host: string; port: number } | null = null;

  close(): void {
    this.server?.close();
    this.server = null;
    this.client?.end();
    this.client = null;
  }
}
