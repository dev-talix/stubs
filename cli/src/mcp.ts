// R4: the same pull and check, as MCP tools on stdio. Tool results carry key names only, and
// failures come back as results with isError, never as thrown errors.

import { isAbsolute, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { withClient } from "../../src/core/api";
import type { Transport } from "../../src/core/ticket";
import { checkStub } from "./check";
import { resolveOrigin } from "./links";
import { pullStub } from "./pull";
import { fail, isFailure, type Failure } from "./result";
import { redactDeep } from "./redact";
import { packageVersion } from "./version";

export interface McpDeps {
  cwd: string;
  /** Home directory, for this machine's identity (locked links). */
  home: string;
  env: Record<string, string | undefined>;
  makeTransport: (origin: string) => Transport;
}

function toolResult(result: { ok: true } | Failure): CallToolResult {
  // The R6 choke point for MCP: every string field is redacted before it reaches the client.
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(redactDeep(result)) }];
  return result.ok ? { content } : { content, isError: true };
}

/** Runs a tool body so that nothing it throws escapes, and nothing thrown is echoed back. */
async function guarded(body: () => Promise<{ ok: true } | Failure>): Promise<CallToolResult> {
  try {
    return toolResult(await body());
  } catch {
    return toolResult(fail("error", "Unexpected error."));
  }
}

const LINK_DESCRIPTION = "The stubs link, including everything after #.";

// Schemas accept anything, so the SDK never answers with its own validation text (which can
// echo input). Each handler validates its arguments and answers in the R1 envelope instead.
// An unknown tool name still gets the SDK's "Tool <name> not found": the client chose that name.
const pullInput = z
  .object({
    link: z.unknown().describe(LINK_DESCRIPTION),
    file: z.unknown().describe("Env file to write, relative to and inside the project. Defaults to .env.local."),
    overwrite: z.unknown().describe("Replace values of keys that already exist instead of skipping them."),
  })
  .passthrough();
const checkInput = z.object({ link: z.unknown().describe(LINK_DESCRIPTION) }).passthrough();

type Args = Record<string, unknown>;

function readPullArgs(args: Args, cwd: string): { link: string; file?: string; overwrite: boolean } | Failure {
  const { link, file, overwrite } = args;
  if (typeof link !== "string" || link.trim() === "") return fail("invalid", "`link` must be a stubs link. Nothing was consumed.");
  if (file !== undefined && (typeof file !== "string" || file.trim() === "")) {
    return fail("invalid", "`file` must be a path relative to the project. Nothing was consumed.");
  }
  if (file !== undefined && !insideProject(file, cwd)) {
    return fail("invalid", "`file` must stay inside the project directory: no absolute paths and no `..`. Nothing was consumed.");
  }
  if (overwrite !== undefined && typeof overwrite !== "boolean") {
    return fail("invalid", "`overwrite` must be true or false. Nothing was consumed.");
  }
  return { link, file, overwrite: overwrite ?? false };
}

/**
 * An agent's env file belongs in its project. This is a lexical check on the path the client
 * sent, so a caller can't aim the write at an arbitrary location; a symlink the user placed
 * inside the project is their own choice and is left to the git guard.
 */
function insideProject(file: string, cwd: string): boolean {
  if (isAbsolute(file)) return false;
  const rel = relative(cwd, resolve(cwd, file));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "stubs", version: packageVersion() });
  const makeTransport = (origin: string) => withClient(deps.makeTransport(origin), "mcp");

  server.registerTool(
    "pull_stub",
    {
      description: `Open a one-time Stubs link and write its values into the project's env file. Returns key names only. Never read or print the env file afterwards; run commands that need the values with \`npx -y --loglevel=warn -- @talix/stubs@${packageVersion()} run -- <cmd>\`, which masks them in the output.`,
      inputSchema: pullInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args: Args) =>
      guarded(async () => {
        const input = readPullArgs(args, deps.cwd);
        if (isFailure(input)) return input;
        const origin = resolveOrigin(undefined, deps.env.STUBS_ORIGIN);
        if (isFailure(origin)) return origin;
        return pullStub(
          { link: input.link, origin, to: input.file, overwrite: input.overwrite },
          { transport: makeTransport(origin), cwd: deps.cwd, identity: deps },
        );
      }),
  );

  server.registerTool(
    "check_stub",
    {
      description: "Check whether a one-time Stubs link is still sealed, without opening it.",
      inputSchema: checkInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args: Args) =>
      guarded(async () => {
        if (typeof args.link !== "string" || args.link.trim() === "") {
          return fail("invalid", "`link` must be a stubs link.");
        }
        const origin = resolveOrigin(undefined, deps.env.STUBS_ORIGIN);
        if (isFailure(origin)) return origin;
        return checkStub({ link: args.link, origin }, { transport: makeTransport(origin), identity: deps });
      }),
  );

  return server;
}

/**
 * Redacts every outgoing JSON-RPC message, not just our tool results: the SDK writes some text
 * itself (for example "Tool <name> not found", which echoes whatever name the client sent).
 * Our own payloads are already redacted, so this is a no-op for them. The id is left alone so
 * responses still match their requests.
 */
export function redactOutgoing(transport: StdioServerTransport): StdioServerTransport {
  const send = transport.send.bind(transport);
  transport.send = (message) => {
    const { id, ...rest } = message as JSONRPCMessage & { id?: unknown };
    const redacted = redactDeep(rest);
    return send((id === undefined ? redacted : { ...redacted, id }) as JSONRPCMessage);
  };
  return transport;
}

export async function startMcpServer(deps: McpDeps): Promise<void> {
  await createMcpServer(deps).connect(redactOutgoing(new StdioServerTransport()));
}
