// Helpers for talking to remote MCP servers over the Streamable HTTP transport.
//
// The MCP Streamable HTTP spec requires the client to advertise that it accepts
// BOTH a single JSON response and an SSE stream on every POST:
//
//   Accept: application/json, text/event-stream
//
// Spec-compliant servers reject requests missing this header with 406 Not
// Acceptable, and when the header is present they are free to answer with an
// SSE stream (`event: message\ndata: {…}`) instead of a bare JSON body. So any
// code path that POSTs JSON-RPC to a remote `/mcp` endpoint must (a) send the
// Accept header and (b) be able to read an SSE-framed response.

/** The Accept header value required by the MCP Streamable HTTP transport. */
export const MCP_HTTP_ACCEPT = "application/json, text/event-stream";

/**
 * Default headers for an MCP Streamable HTTP JSON-RPC POST. Caller-supplied
 * headers (e.g. resolved credentials) are preserved, while the required
 * Streamable HTTP Accept value is kept authoritative.
 */
export function mcpHttpRequestHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    ...extra,
    accept: MCP_HTTP_ACCEPT,
  };
}

/** Response header carrying the Streamable HTTP session id. */
export const MCP_HTTP_SESSION_HEADER = "mcp-session-id";

/**
 * Protocol version advertised on `initialize` over Streamable HTTP.
 *
 * Streamable HTTP — and the `mcp-session-id` header this module depends on —
 * postdates the `2024-11-05` revision, so this deliberately advertises a newer
 * one. Nothing here requires the server to agree: a server that speaks an older
 * revision answers `initialize` with whatever it does support, and the only
 * value read back off that response is the session id.
 */
export const MCP_HTTP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Does this response mean the server requires an initialized MCP session?
 *
 * Servers built on the reference Streamable HTTP transport are stateful: every
 * method that arrives without a session id — `tools/list` and `tools/call`
 * included — is rejected with
 * `400 {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: No valid session ID provided"}}`.
 * Stateless servers never answer this way, so callers can treat a true result
 * as "retry inside a session" and leave every other status alone.
 */
export function isMcpMissingSessionResponse(status: number, bodyText: string): boolean {
  if (status !== 400 || !bodyText) return false;
  // The wording is an implementation detail rather than part of the spec, so
  // accept the JSON-RPC error code plus any mention of a session as a fallback.
  // A false positive costs one extra `initialize` round trip and nothing more,
  // so this errs towards recognising the condition.
  return /no valid session id/i.test(bodyText) || (/-32000/.test(bodyText) && /session/i.test(bodyText));
}

export type McpHttpSession = {
  /** Headers to merge into every subsequent JSON-RPC POST on this session. */
  headers: Record<string, string>;
  /** True when the server issued no session id, i.e. it is stateless. */
  stateless: boolean;
};

/**
 * Open an MCP session by performing the `initialize` handshake plus the
 * `notifications/initialized` follow-up that stateful servers gate other
 * methods behind.
 *
 * Best-effort by design: any failure returns `null` so the caller keeps the
 * response it already has and its existing error handling stays authoritative.
 */
export async function mcpHttpOpenSession(input: {
  endpoint: string;
  /** Reported in `clientInfo`; callers pass the running server's version. */
  clientVersion: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<McpHttpSession | null> {
  const { endpoint, clientVersion, headers = {}, signal } = input;
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "manual",
    headers: mcpHttpRequestHeaders(headers),
    signal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "paperclip-mcp-initialize",
      method: "initialize",
      params: {
        protocolVersion: MCP_HTTP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "paperclip", version: clientVersion },
      },
    }),
  }).catch(() => null);
  if (!response || !response.ok) return null;
  // Drain the initialize result so the socket is released. The session is
  // registered server-side by the time the headers arrive, so a read failure
  // here (e.g. an SSE stream the server holds open) must not void it.
  await response.text().catch(() => "");
  const sessionId = response.headers.get(MCP_HTTP_SESSION_HEADER);
  if (!sessionId) return { headers: {}, stateless: true };
  const sessionHeaders = { [MCP_HTTP_SESSION_HEADER]: sessionId };
  await fetch(endpoint, {
    method: "POST",
    redirect: "manual",
    headers: mcpHttpRequestHeaders({ ...headers, ...sessionHeaders }),
    signal,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  })
    .then((res) => res.text().catch(() => ""))
    .catch(() => undefined);
  return { headers: sessionHeaders, stateless: false };
}

function looksLikeJsonRpcMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return "result" in record || "error" in record || "method" in record || "id" in record;
}

/**
 * Parse the body of an MCP Streamable HTTP response into its JSON-RPC payload.
 *
 * Handles both response shapes the transport allows:
 *  - `application/json`: the body is the JSON-RPC message directly.
 *  - `text/event-stream`: one or more SSE events; we return the JSON payload of
 *    the first `data:` event that parses as a JSON-RPC message.
 *
 * Falls back to a plain JSON parse when the content type is unknown so we stay
 * compatible with non-compliant servers that ignore the Accept header.
 */
export function parseMcpHttpResponseBody(bodyText: string, contentType: string | null): unknown {
  const isEventStream = (contentType ?? "").toLowerCase().includes("text/event-stream");
  if (!isEventStream) {
    return JSON.parse(bodyText) as unknown;
  }

  // Split the SSE stream into events on blank lines, then collect each event's
  // `data:` lines (which may span multiple lines per the SSE spec).
  const events = bodyText.replace(/\r\n/g, "\n").split(/\n\n+/);
  let lastError: unknown = null;
  let firstParsed: unknown;
  let sawData = false;
  for (const event of events) {
    const dataLines = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""));
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n");
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!sawData) {
      firstParsed = parsed;
      sawData = true;
    }
    if (looksLikeJsonRpcMessage(parsed)) {
      return parsed;
    }
  }
  if (sawData) return firstParsed;
  if (lastError) throw lastError;
  throw new SyntaxError("MCP SSE response contained no data events");
}
