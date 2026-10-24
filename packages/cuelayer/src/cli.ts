#!/usr/bin/env node
/**
 * `cuetap` — the CueLayer command line interface.
 *
 * ```sh
 * cuetap extract policy.docx            # cue-preserving text
 * cuetap extract policy.docx --json     # the full result, as JSON
 * cuetap extract policy.docx --plain    # plain text only
 * cuetap serve --port 8765              # the local parse service
 * ```
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { extractCues } from "./index.js";
import { startService } from "./service.js";

const USAGE = `cuetap — cue-preserving document extraction

Usage:
  cuetap extract <file> [--json] [--plain] [--formatting]
  cuetap serve [--port <port>] [--host <host>] [--token <token>]
  cuetap --help
  cuetap --version

Commands:
  extract    Extract authoring cues from a document (DOCX).
  serve      Run the local parse service the browser extension talks to.

Options:
  --json         Print the full result as JSON (text, marked, cues, provenance).
  --plain        Print plain text only, ignoring the cue layer.
  --formatting   Also emit bold/italic/underline/strike cues. Off by default:
                 these cues are too common in real documents to carry signal.
  --port <n>     Port for \`serve\`. Default 8765.
  --host <addr>  Bind address for \`serve\`. Default 127.0.0.1 (loopback only).
  --token <t>    Require this bearer token on requests to the service.
`;

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--") && isValueFlag(body)) {
      flags.set(body, next);
      i += 1;
    } else {
      flags.set(body, true);
    }
  }

  return { command, positional, flags };
}

function isValueFlag(name: string): boolean {
  return name === "port" || name === "host" || name === "token";
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "--help" || args.command === "-h" || args.command === "help" || args.command === "") {
    process.stdout.write(USAGE);
    return args.command === "" ? 1 : 0;
  }
  if (args.command === "--version" || args.command === "-v") {
    process.stdout.write(`${await readVersion()}\n`);
    return 0;
  }

  if (args.command === "extract") {
    return runExtract(args);
  }
  if (args.command === "serve") {
    return runServe(args);
  }

  process.stderr.write(`cuetap: unknown command "${args.command}"\n\n${USAGE}`);
  return 1;
}

async function readVersion(): Promise<string> {
  try {
    const url = new URL("../package.json", import.meta.url);
    const raw = await readFile(url, "utf-8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function runExtract(args: ParsedArgs): Promise<number> {
  const file = args.positional[0];
  if (!file) {
    process.stderr.write("cuetap extract: no file given\n");
    return 1;
  }

  let bytes: Uint8Array;
  try {
    bytes = await readFile(file);
  } catch (err) {
    process.stderr.write(`cuetap extract: cannot read ${file}: ${errorMessage(err)}\n`);
    return 1;
  }

  const outcome = await extractCues(bytes, {
    includeFormatting: args.flags.get("formatting") === true,
  });

  if (!outcome.ok) {
    process.stderr.write(
      `cuetap: ${outcome.reason}${outcome.detail ? ` — ${outcome.detail}` : ""}\n`,
    );
    if (outcome.text) process.stdout.write(`${outcome.text}\n`);
    return 2;
  }

  if (args.flags.get("plain") === true) {
    process.stdout.write(`${outcome.text}\n`);
    return 0;
  }

  if (args.flags.get("json") === true) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${outcome.marked}\n`);
  return 0;
}

async function runServe(args: ParsedArgs): Promise<number> {
  const port = Number.parseInt(String(args.flags.get("port") ?? "8765"), 10);
  const host = String(args.flags.get("host") ?? "127.0.0.1");
  const token = typeof args.flags.get("token") === "string" ? (args.flags.get("token") as string) : undefined;

  const service = await startService({ port, host, token });
  process.stdout.write(
    `cuetap service listening on http://${host}:${service.port}\n` +
      `  POST /extract   (application/octet-stream)\n` +
      `  GET  /health    (version + protocol)\n` +
      `  GET  /version\n` +
      (service.token ? "  auth: bearer token required\n" : "  auth: none (loopback only)\n"),
  );

  const shutdown = (): void => {
    void service.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive.
  await new Promise<void>(() => {});
  return 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`cuetap: ${errorMessage(err)}\n`);
    process.exitCode = 1;
  });
